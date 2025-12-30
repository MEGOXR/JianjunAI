# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a full-stack medical consultation application for plastic surgery featuring:
- **Frontend**: WeChat Mini Program (微信小程序) for mobile clients
- **Backend**: Node.js/Express server with WebSocket support for real-time chat
- **AI Integration**: Azure OpenAI service for medical consultation responses

## Architecture

### Backend Architecture
- **WebSocket Server**: Real-time bidirectional communication at `backend/src/index.js:24`
- **Chat Controller**: Handles AI conversation flow with session management at `backend/src/controllers/chatController.js`
- **Streaming Responses**: AI responses stream in real-time using Azure OpenAI's streaming API
- **Session Management**: User conversations persist via userId-based Map storage

### Frontend Architecture  
- **Single Page App**: Main chat interface at `frontend/pages/index/index.js`
- **WebSocket Client**: Manages connection, reconnection, and message handling
- **Voice Features**: Recording, speech-to-text, and text-to-speech capabilities
- **Message Persistence**: Local storage for chat history using WeChat's storage API

## Development Commands

### Backend
```bash
cd backend
npm install          # Install dependencies
npm start           # Production mode (port 3000)
npm run dev         # Development mode with nodemon
```

### Frontend
- Open `frontend` folder in WeChat Developer Tools
- Configure AppID in project settings
- Enable "不校验合法域名" for local development

## Environment Configuration

Backend requires `.env` file with:
```
# Azure OpenAI (Required)
AZURE_OPENAI_ENDPOINT=<your-endpoint>
AZURE_OPENAI_API_KEY=<your-api-key>
OPENAI_API_VERSION=<api-version>
AZURE_OPENAI_DEPLOYMENT_NAME=<deployment-name>

# Azure Blob Storage (Required for image upload)
AZURE_STORAGE_CONNECTION_STRING=<your-connection-string>

# Supabase (Optional - for persistent storage)
SUPABASE_URL=<your-supabase-url>
SUPABASE_ANON_KEY=<your-supabase-key>
USE_SUPABASE=true

# Memobase (Optional - for user memory)
MEMOBASE_PROJECT_URL=<your-memobase-url>
MEMOBASE_API_KEY=<your-memobase-key>
USE_MEMOBASE=true

# Server
PORT=3000
JWT_SECRET=<your-jwt-secret>
```

**Security Note**: Azure OpenAI and Azure Blob Storage credentials are required. The application will fail to start if these are missing. Supabase and Memobase are optional but recommended for full functionality.

## Key Implementation Details

### WebSocket Protocol
- Client sends: `{ "prompt": "user message" }`
- Server responds with streaming chunks: `{ "data": "partial response" }`
- Completion signal: `{ "done": true }`
- Error format: `{ "error": "message", "details": "..." }`

### AI Context Management
- System prompt defines AI persona as "杨院长" (Director Yang)
- Conversation history limited to 10 messages to manage token usage
- Each user session maintains independent conversation context
- Persistent chat history stored in `backend/data/users.json`
- Intelligent greeting system based on user history and time since last visit
- Automatic name extraction from user messages

### User Data Management
- **UserDataService** (`backend/src/services/userDataService.js`): Handles persistent storage of user data
- **GreetingService** (`backend/src/services/greetingService.js`): Generates contextual greetings
- **NameExtractorService** (`backend/src/services/nameExtractorService.js`): Uses LLM to intelligently extract user names from conversation
- User data includes: chat history, last visit time, extracted names, WeChat nickname
- Name extraction uses GPT-4 with JSON response format for accurate identification

### Image Upload & Storage
- **AzureBlobService** (`backend/src/services/azureBlobService.js`): Handles image uploads to Azure Blob Storage
- **Frontend**: Image selection, compression (max 1024x1024), and base64 conversion
- **Upload Flow**:
  1. User selects/takes photos (max 3 images)
  2. Frontend compresses and converts to base64
  3. Backend uploads to Azure Blob Storage
  4. GPT-5.2 Vision API analyzes images
  5. Image URLs + AI analysis saved to Supabase
  6. AI analysis results saved to Memobase for user memory
- **Storage Structure**:
  - Azure Blob: `user-images/{userId}/{timestamp}_{randomId}.jpg`
  - Supabase: Image metadata + analysis in `chat_messages.metadata`
  - Memobase: Formatted analysis summary in user memory

### Frontend State Management
- Messages stored in component data with real-time updates
- Automatic reconnection on WebSocket disconnect (max 5 attempts with exponential backoff)
- Scroll management for chat history with "scroll to bottom" functionality
- WeChat user profile integration for personalized experience
- Greeting messages displayed when user connects

### Security Features
- **Input Validation**: All user inputs are validated and sanitized before processing
- **Rate Limiting**: 60 requests per minute per user, 30 messages per minute for chat
- **XSS Protection**: User inputs are sanitized to prevent script injection
- **UserId Validation**: Strict format validation prevents path traversal attacks
- **Memory Management**: Automatic cleanup of inactive chat histories (24-hour idle timeout)
- **Connection Security**: WebSocket connections require valid user credentials

## Deployment Configuration

### Azure App Service Deployment
The project is configured for automatic deployment to Azure App Service via GitHub Actions:

1. **Entry Point**: `backend/src/index.js` (updated from root-level index.js)
2. **Deployment Files**:
   - `backend/web.config`: IIS configuration for Azure App Service
   - `backend/.deployment`: Kudu deployment configuration
   - `backend/deploy.cmd`: Custom deployment script
   - `.github/workflows/azure-deploy.yml`: GitHub Actions workflow

### Important Notes for Deployment
- **Structure Change**: Project was reorganized from single-folder to `backend/` + `frontend/` structure
- **Entry Point Updated**: Main entry changed from `index.js` to `src/index.js`
- **Environment Variables**: Ensure all Azure OpenAI credentials are set in Azure App Service configuration
- **WebSocket Support**: Azure App Service supports WebSocket connections by default

### Required Azure Configuration
1. Set environment variables in Azure App Service:
   - `AZURE_OPENAI_ENDPOINT`
   - `AZURE_OPENAI_API_KEY`
   - `OPENAI_API_VERSION`
   - `AZURE_OPENAI_DEPLOYMENT_NAME`
2. Enable WebSocket support in Azure portal
3. GitHub repository secrets (already configured):
   - `AZUREAPPSERVICE_CLIENTID_7F3E56B4908B41C9AEB13311D5F2B992`
   - `AZUREAPPSERVICE_TENANTID_648EB4C2AB8D4A029248D8C4F89379A5`
   - `AZUREAPPSERVICE_SUBSCRIPTIONID_7F5D7705906945B287AA55D978D94F7F`

### Deployment Process Changes
- **Build step**: Now runs `npm install` in `backend/` directory instead of root
- **Package structure**: Only backend code is deployed to Azure
- **Node.js version**: Updated to Node.js 20.x
- **Authentication**: Uses Azure federated credentials instead of publish profile