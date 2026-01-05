# JianjunAI Memobase 部署大全 (DEPLOY_GUIDE)

本指南包含了**自建 Memobase 服务**的完整流程，融合了 Supabase (业务数据) 和 Azure 自建 (AI 记忆) 的最佳实践。

## 🎯 架构概览

- **业务数据**: 使用 **Supabase** (保持现状，无需迁移)。
- **AI 记忆**: 使用 **Azure VM** 运行 Docker 版 Memobase。
- **部署方式**: **GitHub Actions** 全自动部署。

---

## 🛠️ 第一步：准备 Azure 环境

### 1. 购买/创建 Azure 虚拟机
推荐配置：
- **型号**: Open Logic CentOS 或 Ubuntu Server 22.04 LTS
- **规格**: **Standard B2ls_v2** 或 **B2als_v2** (4GB 内存版) - 强烈推荐
    - 注意：请务必选择 **4GB 内存** 的规格。
    - `B2s_v2` (8GB) 也可以，但价格贵一倍，性价比不高。
    - 千万别选 `B2ats_v2` (1GB)，内存不够用。
- **网络**: 在 **Networking** (网络设置) 中添加入站规则 (**Inbound port rules**):
    - 允许 **SSH** (TCP/22)
    - 允许 **Custom** (TCP/8019) -> 这是 Memobase 的 API 端口，必须开放。

### 2. 初始化服务器
SSH 登录您的服务器，安装 Docker：

```bash
# Ubuntu 示例
sudo apt update
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

### 3. 创建部署目录
```bash
mkdir -p ~/memobase
```

---

## 🚢 第二步：配置自动化部署 (CI/CD)

### 1. 获取服务器信息
您需要准备好：
- **IP**: 您的虚拟机公网 IP
- **Key**: 登录用的 SSH 私钥内容

### 2. 配置 GitHub Secrets
在您的 GitHub 仓库 -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**，添加以下三个变量：

| Secret 名称 | 值 (示例) | 说明 |
| :--- | :--- | :--- |
| `AZURE_HOST_IP` | `20.1.2.3` | Azure 虚拟机的 IP 地址 |
| `AZURE_SSH_KEY` | `-----BEGIN OPENSSH PRIVATE KEY...` | 您的 SSH 私钥内容 |

### 3. 修改项目文件

1.  **修改 `deploy/memobase/docker-compose.yml`**:
    把 `image: ghcr.io/YOUR_GITHUB_USERNAME/...` 中的 `YOUR_GITHUB_USERNAME` 替换为您真实的 GitHub 用户名 (全部小写)。

2.  **修改 `deploy/memobase/config.yaml`**:
    填入您的 OpenAI / Azure OpenAI Key。

3.  **激活自动部署**:
    打开 `.github/workflows/deploy_memobase.yml`，将 `if: false` 改为 `if: true`。

---

## 🚀 第三步：首次部署

1.  **提交代码**:
    ```bash
    git add .
    git commit -m "feat: setup memobase deployment"
    git push origin main
    ```

2.  **观察 Action**:
    去 GitHub 仓库的 **Actions** 页面，您会看到 `Deploy Memobase` 正在运行。
    - **Step 1**: 它会构建您自定义的 Docker 镜像。
    - **Step 2**: 它会自动 SSH 到 Azure，把配置发过去，并启动服务。

3.  **验证**:
    部署成功后，在浏览器访问 `http://<Azure_IP>:8019/docs` (Memobase 的 API 文档)，如果能打开，说明服务已上线。

---

## 🔌 第四步：连接后端

最后，回到您的本地开发环境 (或线上 App Service 配置)，更新环境变量：

**文件**: `.env`

```env
# 替换为您的 Azure 虚拟机 IP
MEMOBASE_PROJECT_URL=http://<Azure_IP>:8019

# 替换为您 config.yaml 里自己设的 auth.api_key
MEMOBASE_API_KEY=my_super_secure_password
```

---

## 🔄 日后如何更新？

以后如果您需要修改 Memobase 的逻辑 (比如改 Dockerfile，或者 `deploy/memobase` 下的任何文件)：

👉 **只需要 `git push`**。

GitHub Action 会自动检测到变化，自动重新打包，自动重启 Azure 上的服务。您无需再手动 SSH 登录服务器。
