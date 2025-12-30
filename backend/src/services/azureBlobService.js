/**
 * Azure Blob Storage Service
 * 处理图片上传到 Azure Blob Storage
 */

const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

class AzureBlobService {
  constructor() {
    this.blobServiceClient = null;
    this.containerName = 'user-images';
    this.isEnabled = false;
  }

  /**
   * 初始化 Azure Blob Storage 客户端
   */
  async initialize() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

    if (!connectionString) {
      console.warn('[Azure Blob] 缺少连接字符串配置，图片上传功能将被禁用');
      this.isEnabled = false;
      return false;
    }

    try {
      // 创建 BlobServiceClient
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

      // 确保容器存在
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      await containerClient.createIfNotExists({
        access: 'blob' // 公开访问 blob，但不公开列表
      });

      this.isEnabled = true;
      console.log('[Azure Blob] 客户端初始化成功，容器:', this.containerName);
      return true;
    } catch (error) {
      console.error('[Azure Blob] 初始化失败:', error);
      this.isEnabled = false;
      return false;
    }
  }

  /**
   * 检查服务是否可用
   */
  isAvailable() {
    return this.isEnabled && this.blobServiceClient !== null;
  }

  /**
   * 上传图片到 Azure Blob Storage
   * @param {Buffer} imageBuffer - 图片数据（Buffer格式）
   * @param {string} userId - 用户ID
   * @param {object} options - 可选参数 { contentType, metadata }
   * @returns {object} { url, blobName, size }
   */
  async uploadImage(imageBuffer, userId, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Azure Blob Storage service not available');
    }

    try {
      // 生成唯一的 blob 名称
      const timestamp = Date.now();
      const randomId = crypto.randomBytes(8).toString('hex');
      const blobName = `${userId}/${timestamp}_${randomId}.jpg`;

      // 获取容器客户端
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // 上传参数
      const uploadOptions = {
        blobHTTPHeaders: {
          blobContentType: options.contentType || 'image/jpeg'
        },
        metadata: {
          userId: userId,
          uploadedAt: new Date().toISOString(),
          ...options.metadata
        }
      };

      // 上传图片
      await blockBlobClient.upload(imageBuffer, imageBuffer.length, uploadOptions);

      // 获取 URL
      const url = blockBlobClient.url;

      console.log(`[Azure Blob] 图片上传成功: ${blobName}, 大小: ${imageBuffer.length} 字节`);

      return {
        url,
        blobName,
        size: imageBuffer.length,
        containerName: this.containerName
      };
    } catch (error) {
      console.error('[Azure Blob] 上传图片失败:', error);
      throw error;
    }
  }

  /**
   * 批量上传图片
   * @param {Array<Buffer>} imageBuffers - 图片Buffer数组
   * @param {string} userId - 用户ID
   * @returns {Array<object>} 上传结果数组
   */
  async uploadImages(imageBuffers, userId) {
    if (!this.isAvailable()) {
      throw new Error('Azure Blob Storage service not available');
    }

    const uploadPromises = imageBuffers.map(buffer =>
      this.uploadImage(buffer, userId)
    );

    try {
      const results = await Promise.all(uploadPromises);
      console.log(`[Azure Blob] 批量上传完成: ${results.length} 张图片`);
      return results;
    } catch (error) {
      console.error('[Azure Blob] 批量上传失败:', error);
      throw error;
    }
  }

  /**
   * 删除图片
   * @param {string} blobName - Blob 名称
   * @returns {boolean} 是否成功
   */
  async deleteImage(blobName) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.deleteIfExists();
      console.log(`[Azure Blob] 图片删除成功: ${blobName}`);
      return true;
    } catch (error) {
      console.error(`[Azure Blob] 删除图片失败 ${blobName}:`, error);
      return false;
    }
  }

  /**
   * 获取图片元数据
   * @param {string} blobName - Blob 名称
   * @returns {object|null} 图片元数据
   */
  async getImageMetadata(blobName) {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const properties = await blockBlobClient.getProperties();

      return {
        url: blockBlobClient.url,
        size: properties.contentLength,
        contentType: properties.contentType,
        metadata: properties.metadata,
        createdOn: properties.createdOn
      };
    } catch (error) {
      console.error(`[Azure Blob] 获取元数据失败 ${blobName}:`, error);
      return null;
    }
  }

  /**
   * 将 base64 图片转换为 Buffer
   * @param {string} base64String - base64 编码的图片（可以包含 data:image/jpeg;base64, 前缀）
   * @returns {Buffer} 图片 Buffer
   */
  base64ToBuffer(base64String) {
    // 移除 data:image/jpeg;base64, 前缀（如果存在）
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  }
}

module.exports = new AzureBlobService();
