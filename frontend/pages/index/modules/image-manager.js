/**
 * Image Manager Module
 * 处理图片选择、压缩、转换为 base64
 */
class ImageManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.maxImages = 3;  // 最多支持 3 张图片
    this.maxSize = 1024;  // 压缩后最大尺寸 1024x1024
    this.quality = 0.8;   // JPEG 压缩质量
  }

  /**
   * 选择图片
   * @param {string} sourceType - 图片来源: 'camera' 或 'album'，默认两者都支持
   */
  chooseImage(sourceType = 'both') {
    const currentCount = this.page.data.selectedImages.length;
    const remainingCount = this.maxImages - currentCount;

    if (remainingCount <= 0) {
      wx.showToast({
        title: `最多上传${this.maxImages}张图片`,
        icon: 'none'
      });
      return;
    }

    // 根据来源类型设置 sourceType 参数
    let sourceTypes = ['album', 'camera'];
    if (sourceType === 'camera') {
      sourceTypes = ['camera'];
    } else if (sourceType === 'album') {
      sourceTypes = ['album'];
    }

    wx.chooseImage({
      count: remainingCount,
      sizeType: ['compressed'],  // 优先使用压缩图
      sourceType: sourceTypes,
      success: (res) => {
        this.handleImageSelection(res.tempFilePaths);
      },
      fail: (err) => {
        console.error('选择图片失败:', err);
        wx.showToast({
          title: '选择图片失败',
          icon: 'none'
        });
      }
    });
  }

  /**
   * 处理选中的图片
   */
  async handleImageSelection(tempFilePaths) {
    try {
      // 先将图片添加到上传中列表，显示 loading
      const uploadingImages = tempFilePaths.map(path => ({ path }));
      this.page.setData({
        uploadingImages: [
          ...this.page.data.uploadingImages,
          ...uploadingImages
        ]
      });

      const compressedImages = [];

      for (let i = 0; i < tempFilePaths.length; i++) {
        const filePath = tempFilePaths[i];

        // 压缩图片
        const compressedPath = await this.compressImage(filePath);
        compressedImages.push(compressedPath);

        // 从上传中列表移除，添加到已完成列表
        const currentUploading = [...this.page.data.uploadingImages];
        const currentSelected = [...this.page.data.selectedImages];

        // 移除第一个上传中的项
        currentUploading.shift();
        currentSelected.push(compressedPath);

        this.page.setData({
          uploadingImages: currentUploading,
          selectedImages: currentSelected
        });
      }

      console.log('图片处理完成:', compressedImages.length, '张');
    } catch (error) {
      console.error('处理图片失败:', error);

      // 清空上传中列表
      this.page.setData({
        uploadingImages: []
      });

      wx.showToast({
        title: '处理图片失败',
        icon: 'none'
      });
    }
  }

  /**
   * 压缩图片
   */
  compressImage(filePath) {
    return new Promise((resolve, reject) => {
      // 获取图片信息
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          const { width, height } = info;

          // 计算压缩后的尺寸
          let targetWidth = width;
          let targetHeight = height;

          if (width > this.maxSize || height > this.maxSize) {
            const ratio = Math.min(this.maxSize / width, this.maxSize / height);
            targetWidth = Math.floor(width * ratio);
            targetHeight = Math.floor(height * ratio);
          }

          // 创建 Canvas 压缩图片
          const canvas = wx.createOffscreenCanvas({
            type: '2d',
            width: targetWidth,
            height: targetHeight
          });

          const ctx = canvas.getContext('2d');
          const image = canvas.createImage();

          image.onload = () => {
            ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

            // 转换为临时文件
            wx.canvasToTempFilePath({
              canvas: canvas,
              fileType: 'jpg',
              quality: this.quality,
              success: (res) => {
                console.log('图片压缩成功:', `${width}x${height} -> ${targetWidth}x${targetHeight}`);
                resolve(res.tempFilePath);
              },
              fail: (err) => {
                console.warn('Canvas 压缩失败，使用原图:', err);
                resolve(filePath);
              }
            });
          };

          image.onerror = (err) => {
            console.warn('图片加载失败，使用原图:', err);
            resolve(filePath);
          };

          image.src = filePath;
        },
        fail: (err) => {
          console.warn('获取图片信息失败，使用原图:', err);
          resolve(filePath);
        }
      });
    });
  }

  /**
   * 将图片转换为 base64
   */
  async imageToBase64(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: filePath,
        encoding: 'base64',
        success: (res) => {
          resolve(`data:image/jpeg;base64,${res.data}`);
        },
        fail: reject
      });
    });
  }

  /**
   * 批量转换图片为 base64
   */
  async convertImagesToBase64(imagePaths) {
    const promises = imagePaths.map(path => this.imageToBase64(path));
    return Promise.all(promises);
  }

  /**
   * 删除选中的图片
   */
  removeImage(index) {
    const selectedImages = [...this.page.data.selectedImages];
    selectedImages.splice(index, 1);
    this.page.setData({ selectedImages });
  }

  /**
   * 清空所有图片
   */
  clearImages() {
    this.page.setData({ selectedImages: [] });
  }
}

module.exports = ImageManager;
