class HeartbeatService {
  constructor() {
    this.connections = new Map();
    this.pingInterval = 30000; // 30 seconds
    this.pongTimeout = 5000; // 5 seconds
    this.cleanupInterval = 60000; // 1 minute
    
    this.startCleanupTimer();
  }

  /**
   * Register a WebSocket connection for heartbeat monitoring
   */
  register(ws) {
    const connectionId = this.generateConnectionId();
    ws.connectionId = connectionId;
    
    const connection = {
      ws,
      lastPong: Date.now(),
      pingTimer: null,
      pongTimer: null,
      isAlive: true
    };
    
    this.connections.set(connectionId, connection);
    this.setupHeartbeat(connection);
    
    console.log(`WebSocket connection registered for heartbeat: ${connectionId}`);
    return connectionId;
  }

  /**
   * Unregister a WebSocket connection
   */
  unregister(ws) {
    const connectionId = ws.connectionId;
    if (!connectionId) return;
    
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.clearTimers(connection);
      this.connections.delete(connectionId);
      console.log(`WebSocket connection unregistered: ${connectionId}`);
    }
  }

  /**
   * Setup heartbeat for a connection
   */
  setupHeartbeat(connection) {
    const { ws } = connection;
    
    // Send ping immediately and then at intervals
    this.sendPing(connection);
    
    // Setup ping interval
    connection.pingTimer = setInterval(() => {
      if (connection.isAlive) {
        this.sendPing(connection);
      } else {
        console.log('Connection not alive, terminating:', ws.connectionId);
        this.terminateConnection(connection);
      }
    }, this.pingInterval);

    // Listen for pong responses
    ws.on('pong', () => {
      connection.lastPong = Date.now();
      connection.isAlive = true;
      
      // Clear pong timeout
      if (connection.pongTimer) {
        clearTimeout(connection.pongTimer);
        connection.pongTimer = null;
      }
      
      console.log(`Received pong from ${ws.connectionId}`);
    });

    // Handle message events for custom heartbeat
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'ping') {
          // Respond to custom ping with pong
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          connection.lastPong = Date.now();
          connection.isAlive = true;
        } else if (message.type === 'pong') {
          // Handle custom pong response
          connection.lastPong = Date.now();
          connection.isAlive = true;
          
          if (connection.pongTimer) {
            clearTimeout(connection.pongTimer);
            connection.pongTimer = null;
          }
        }
      } catch (error) {
        // Not a JSON message or not heartbeat related, ignore
      }
    });
  }

  /**
   * Send ping to connection
   */
  sendPing(connection) {
    const { ws } = connection;
    
    if (ws.readyState !== ws.OPEN) {
      console.log('WebSocket not open, cannot send ping:', ws.connectionId);
      this.terminateConnection(connection);
      return;
    }

    // Mark as potentially not alive
    connection.isAlive = false;
    
    try {
      // Send WebSocket ping frame
      ws.ping();
      
      // Also send custom ping message for clients that don't handle ping frames
      ws.send(JSON.stringify({ 
        type: 'ping', 
        timestamp: Date.now() 
      }));
      
      console.log(`Sent ping to ${ws.connectionId}`);
      
      // Set timeout for pong response
      connection.pongTimer = setTimeout(() => {
        console.log(`Pong timeout for connection ${ws.connectionId}`);
        this.terminateConnection(connection);
      }, this.pongTimeout);
      
    } catch (error) {
      console.error(`Error sending ping to ${ws.connectionId}:`, error);
      this.terminateConnection(connection);
    }
  }

  /**
   * Terminate a connection
   */
  terminateConnection(connection) {
    const { ws } = connection;
    
    console.log(`Terminating connection: ${ws.connectionId}`);
    
    this.clearTimers(connection);
    
    try {
      if (ws.readyState === ws.OPEN) {
        ws.terminate();
      }
    } catch (error) {
      console.error('Error terminating WebSocket:', error);
    }
    
    this.connections.delete(ws.connectionId);
  }

  /**
   * Clear all timers for a connection
   */
  clearTimers(connection) {
    if (connection.pingTimer) {
      clearInterval(connection.pingTimer);
      connection.pingTimer = null;
    }
    
    if (connection.pongTimer) {
      clearTimeout(connection.pongTimer);
      connection.pongTimer = null;
    }
  }

  /**
   * Generate unique connection ID
   */
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Start cleanup timer for stale connections
   */
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupStaleConnections();
    }, this.cleanupInterval);
  }

  /**
   * Clean up stale connections
   */
  cleanupStaleConnections() {
    const now = Date.now();
    const staleTimeout = this.pingInterval * 3; // 3 missed pings
    
    let cleanedCount = 0;
    
    for (const [connectionId, connection] of this.connections.entries()) {
      const { ws, lastPong } = connection;
      
      // Check if connection is stale
      if (now - lastPong > staleTimeout) {
        console.log(`Cleaning up stale connection: ${connectionId}`);
        this.terminateConnection(connection);
        cleanedCount++;
        continue;
      }
      
      // Check if WebSocket is in invalid state
      if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
        console.log(`Cleaning up closed connection: ${connectionId}`);
        this.clearTimers(connection);
        this.connections.delete(connectionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} stale connections. Active connections: ${this.connections.size}`);
    }
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const stats = {
      totalConnections: this.connections.size,
      aliveConnections: 0,
      deadConnections: 0,
      avgResponseTime: 0
    };
    
    let totalResponseTime = 0;
    const now = Date.now();
    
    for (const connection of this.connections.values()) {
      if (connection.isAlive) {
        stats.aliveConnections++;
      } else {
        stats.deadConnections++;
      }
      
      totalResponseTime += (now - connection.lastPong);
    }
    
    if (stats.totalConnections > 0) {
      stats.avgResponseTime = Math.round(totalResponseTime / stats.totalConnections);
    }
    
    return stats;
  }

  /**
   * Graceful shutdown
   */
  shutdown() {
    console.log('Shutting down heartbeat service...');
    
    // Clear all connections
    for (const connection of this.connections.values()) {
      this.clearTimers(connection);
      
      try {
        if (connection.ws.readyState === connection.ws.OPEN) {
          connection.ws.close(1001, 'Server shutting down');
        }
      } catch (error) {
        console.error('Error closing WebSocket during shutdown:', error);
      }
    }
    
    this.connections.clear();
    console.log('Heartbeat service shutdown complete');
  }
}

module.exports = new HeartbeatService();