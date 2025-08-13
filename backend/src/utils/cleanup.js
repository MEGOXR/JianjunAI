const fs = require('fs').promises;
const path = require('path');

class CleanupUtil {
  /**
   * 清理指定目录中的旧文件
   * @param {string} directory - 目录路径
   * @param {number} maxAge - 最大文件年龄（毫秒）
   */
  async cleanOldFiles(directory, maxAge) {
    try {
      // 确保目录存在
      try {
        await fs.access(directory);
      } catch (err) {
        console.log(`[Cleanup] 目录不存在，跳过清理: ${directory}`);
        return;
      }

      const files = await fs.readdir(directory);
      const now = Date.now();
      let cleanedCount = 0;
      
      for (const file of files) {
        // 跳过 .gitkeep 文件
        if (file === '.gitkeep') continue;
        
        const filePath = path.join(directory, file);
        
        try {
          const stats = await fs.stat(filePath);
          
          // 只清理文件，不清理目录
          if (stats.isFile() && (now - stats.mtimeMs > maxAge)) {
            await fs.unlink(filePath);
            cleanedCount++;
            console.log(`[Cleanup] 删除过期文件: ${file}`);
          }
        } catch (err) {
          console.error(`[Cleanup] 处理文件失败 ${file}:`, err.message);
        }
      }
      
      if (cleanedCount > 0) {
        console.log(`[Cleanup] 共清理 ${cleanedCount} 个过期文件`);
      }
    } catch (error) {
      console.error('[Cleanup] 清理失败:', error.message);
    }
  }

  /**
   * 获取目录大小
   * @param {string} directory - 目录路径
   * @returns {Promise<number>} 目录大小（字节）
   */
  async getDirectorySize(directory) {
    try {
      const files = await fs.readdir(directory);
      let totalSize = 0;
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
        }
      }
      
      return totalSize;
    } catch (error) {
      console.error('[Cleanup] 获取目录大小失败:', error.message);
      return 0;
    }
  }

  /**
   * 清理并报告状态
   * @param {string} directory - 目录路径
   * @param {number} maxAge - 最大文件年龄（毫秒）
   */
  async cleanupAndReport(directory, maxAge) {
    const sizeBefore = await this.getDirectorySize(directory);
    await this.cleanOldFiles(directory, maxAge);
    const sizeAfter = await this.getDirectorySize(directory);
    
    if (sizeBefore !== sizeAfter) {
      const freedSpace = sizeBefore - sizeAfter;
      console.log(`[Cleanup] 释放空间: ${(freedSpace / 1024).toFixed(2)} KB`);
    }
  }
}

module.exports = new CleanupUtil();