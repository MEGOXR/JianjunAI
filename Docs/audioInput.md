前端（微信小程序）要点

音频采集参数

用 wx.getRecorderManager()

采样率：16000 Hz

通道：mono

编码：原始 PCM 16-bit little-endian（若设备端必须编码成 AAC/MP3，会增加延迟与解码开销，建议直 PCM）

帧切片：每 100–200ms 取一帧（更小帧更低延迟但更占带宽）

传输

与你后端 wss://your-domain/asr 建 WebSocket，binaryType='arraybuffer'。

发送帧：固定长度（如 3200 bytes≈100ms@16kHz*2字节），在每次 onFrameRecorded 回调里 socket.send(arrayBuffer)。

开始/停止：

发送 {"type":"start", "lang":"zh-CN", "sessionId":"..."}

结束录音后发送 {"type":"end"} 以触发后端收尾（final result）。

依赖

npm i microsoft-cognitiveservices-speech-sdk ws


流式识别（PushAudioInputStream）

用 SpeechSDK.AudioInputStream.createPushStream() 接收前端来的音频，持续 push。

SpeechConfig：

speechRecognitionLanguage = 'zh-CN'

设置 ProfanityOption（如 SpeechSDK.ProfanityOption.Masked）

如有热词/专有名词，启用 PhraseListGrammar。

开启中间结果（默认有 recognizing 事件），以及最终结果（recognized 事件）。

把中间结果推给前端与 LLM

recognizing（增量）：发 {type:'partial', text}

recognized（最终句）：发 {type:'final', text}，随后调用 LLM，把 LLM 输出再推 {type:'llm', text}

边转写边理解：对 partial 可做“低频提示/字幕”，真正喂给 LLM的以 稳定 partial 或 final 为准（降低幻听）。