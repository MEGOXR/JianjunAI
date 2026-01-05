# 在 Azure 上架设 Memobase 服务指南

本指南将协助您在 Azure 云服务上部署私有化的 Memobase 服务。

## 方案选择

我们推荐使用 **Azure Virtual Machine (虚拟机)** 进行部署，这是最简单且成本可控的方式，完全兼容 Docker Compose。

## 部署步骤

### 1. 创建 Azure 虚拟机

1. 登录 [Azure Portal](https://portal.azure.com)。
2. 创建一个新的资源：**Virtual Machine**。
3. **配置建议**：
   - **Image**: Ubuntu Server 22.04 LTS (或 24.04 LTS)
   - **Size**: Standard B2s (2 vCPU, 4 GiB 内存) 或更高。Memobase + Postgres + Redis 至少需要 4GB 内存以保证流畅运行。
   - **Inbound ports**: 允许 SSH (22) 和 HTTP/Custom (8019)。您需要在"Networking"标签页添加入站规则，允许 8019 端口的访问。

### 2. 连接虚拟机并安装 Docker

使用 SSH 连接到您的虚拟机，然后执行以下命令安装 Docker：

```bash
# 更新系统
sudo apt-get update
sudo apt-get upgrade -y

# 安装 Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 将当前用户加入 docker 组 (避免每次都输 sudo)
sudo usermod -aG docker $USER
newgrp docker

# 验证安装
docker --version
docker compose version
```

### 3. 部署 Memobase

1. **创建部署目录**：
   ```bash
   mkdir -p ~/memobase
   cd ~/memobase
   ```

2. **上传配置文件**：
   您可以使用 `scp` 或者直接在服务器上创建文件。将本项目 `deploy/memobase/` 目录下的 `docker-compose.yml` 和 `config.yaml` 复制到服务器的 `~/memobase` 目录中。

   **如果直接在服务器创建**：
   ```bash
   nano docker-compose.yml
   # (粘贴 docker-compose.yml 内容，按 Ctrl+O 保存，Ctrl+X 退出)

   nano config.yaml
   # (粘贴 config.yaml 内容)
   ```

3. **修改配置**：
   重要：请务必修改 `config.yaml` 中的以下内容：
   - `llm.api_key`: 您的 OpenAI 或 Azure OpenAI Key。
   - `auth.api_key`: 设置一个安全的密钥，您的后端将使用此密钥连接 Memobase。

4. **启动服务**：
   ```bash
   docker compose up -d
   ```

5. **验证运行**：
   查看日志确保没有报错：
   ```bash
   docker compose logs -f
   ```
   如果一切正常，服务将在 `8019` 端口启动。

### 4. 更新 JianjunAI 后端配置

部署完成后，获取您 Azure 虚拟机的 **Public IP** 地址。

回到您的本地项目 (`d:\AIDev\JianjunAI\backend`), 打开 `.env` 文件 (或者在 Azure App Service 的 Environment Variables 中)，更新以下配置：

```env
# Memobase 配置
# 替换 <Your-Azure-VM-IP> 为您的虚拟机公网IP
MEMOBASE_PROJECT_URL=http://<Your-Azure-VM-IP>:8019

# 替换为您在 config.yaml 中设置的 auth.api_key
MEMOBASE_API_KEY=change_this_to_a_secure_random_string
```

## 注意事项

- **数据持久化**: `docker-compose.yml` 已经配置了 Docker Volume，重启容器数据不会丢失。
- **安全性**: 
  - 务必在 Azure Network Security Group (NSG) 中限制 8019 端口的访问来源 IP（例如只允许您的 Azure App Service IP 或开发机 IP），或者使用 VPN。
  - 不要使用默认的弱密码。
- **Azure OpenAI**: 如果使用 Azure OpenAI，请确保 `config.yaml` 中的 `base_url` 和 `api_version` 正确填写。

## 故障排查

如果服务无法启动，请检查 `docker compose logs`。常见问题通常是：
1. 端口冲突 (8019 被占用)
2. LLM Key 配置错误
3. 内存不足 (建议至少 4GB 内存)
