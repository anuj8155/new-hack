import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./styles.css";

const StreamyardClone = () => {
  const userVideoRef = useRef(null);
  const chatContainerRef = useRef(null);
  const [mediaStream, setMediaStream] = useState(null);
  const [rtmpUrls, setRtmpUrls] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [currentDateTime, setCurrentDateTime] = useState("2025-02-20 09:30:53");
  const [messages, setMessages] = useState([]); // Start with empty array
  const [newMessage, setNewMessage] = useState("");
  const [viewerCount, setViewerCount] = useState({});
  const socket = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentDateTime(now.toISOString().replace("T", " ").slice(0, 19));
    }, 1000);

    socket.current = io("http://localhost:4000", {
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.current.on("connect", () => setStatusMessage("Connected to server"));
    socket.current.on("disconnect", () => {
      setStatusMessage("Disconnected from server");
      setIsStreaming(false);
      stopMediaRecorder();
    });

    socket.current.on("stream_status", (data) => {
      setStatusMessage(data.message);
      setIsStreaming(data.status === "started");
      if (data.status !== "started") stopMediaRecorder();
    });

    socket.current.on("chat_update", (chats) => {
      console.log("Received chat_update:", chats); // Debug log
      if (Array.isArray(chats) && chats.length > 0) {
        setMessages((prev) => {
          // Append only new messages, avoid duplicates by checking IDs or timestamps
          const newMessages = chats
            .filter((chat) => !prev.some((msg) => msg.timestamp === chat.timestamp && msg.user === chat.user && msg.message === chat.message))
            .map((chat, index) => ({
              id: `${chat.platform}-${Date.now()}-${index}`,
              platform: chat.platform,
              user: chat.user,
              message: chat.message,
              timestamp: chat.timestamp,
            }));
          return [...prev, ...newMessages];
        });
        if (chatContainerRef.current) {
          chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
      }
    });

    socket.current.on("viewer_update", (counts) => setViewerCount(counts));

    getMediaStream();

    return () => {
      clearInterval(timer);
      if (isStreaming) stopStreaming();
      if (socket.current) socket.current.disconnect();
      if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const getMediaStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      setMediaStream(stream);
      if (userVideoRef.current) userVideoRef.current.srcObject = stream;
      setStatusMessage("Camera and microphone ready");
    } catch (error) {
      setStatusMessage(`Media access error: ${error.message}`);
    }
  };

  const stopMediaRecorder = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setMediaRecorder(null);
    }
  };

  const startStreaming = () => {
    if (!mediaStream) return setStatusMessage("No media stream available!");
    const urlsArray = rtmpUrls
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url && (url.startsWith("rtmp://") || url.startsWith("rtmps://")));
    
    if (!urlsArray.length) {
      setStatusMessage("Please enter at least one valid RTMP URL (rtmp:// or rtmps://)");
      return;
    }

    const data = {
      urls: urlsArray,
      accessToken: accessToken || undefined,
      refreshToken: refreshToken || undefined,
    };
    console.log("Sending to backend:", data);
    socket.current.emit("set_rtmp_urls", data);

    setStatusMessage("Starting stream...");
    const recorder = new MediaRecorder(mediaStream, {
      mimeType: "video/webm;codecs=h264",
      videoBitsPerSecond: 1000000,
      audioBitsPerSecond: 128000,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && socket.current.connected) {
        socket.current.emit("binarystream", event.data);
      }
    };
    recorder.start(100);
    setMediaRecorder(recorder);
    setIsStreaming(true);
  };

  const stopStreaming = () => {
    setStatusMessage("Stopping stream...");
    socket.current.emit("stop_streaming");
    stopMediaRecorder();
    setIsStreaming(false);
    setRtmpUrls("");
    setAccessToken("");
    setRefreshToken("");
    // Optionally keep messages: comment out the next line if you want to retain chat history
    // setMessages([]);
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (newMessage.trim()) {
      const timestamp = new Date().toTimeString().split(" ")[0];
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}`, platform: "Local", user: "anuj8155", message: newMessage.trim(), timestamp },
      ]);
      setNewMessage("");
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    }
  };

  return (
    <div className="youtube-dashboard">
      <header className="dashboard-header">
        <div className="header-left">
          <h1>Stream-X</h1>
        </div>
        <div className="header-right">
          <div className="user-info">
            <span className="datetime">{currentDateTime}</span>
            <span className="username">anuj8155</span>
          </div>
        </div>
      </header>

      <div className="dashboard-content">
        <div className="main-section">
          <div className="video-preview">
            <video
              ref={userVideoRef}
              autoPlay
              muted
              playsInline
              className="preview-video"
            ></video>
            <div className="stream-status">
              {isStreaming ? (
                <span className="live-indicator">● LIVE</span>
              ) : (
                <span className="offline-indicator">OFFLINE</span>
              )}
            </div>
          </div>

          <div className="stream-details">
            <div className="title-section">
              <input 
                type="text" 
                placeholder="Add a title that describes your stream" 
                className="stream-title"
              />
              <textarea 
                placeholder="Tell viewers about your stream" 
                className="stream-description"
              />
            </div>
          </div>
        </div>

        <div className="chat-section">
          <div className="chat-header">
            <h3>Live Chat</h3>
            <span className="chat-status">{isStreaming ? "Live Chat" : "Chat Disabled"}</span>
          </div>
          
          <div className="chat-messages" ref={chatContainerRef}>
            {messages.map((msg) => (
              <div key={msg.id} className="chat-message">
                <span className="message-timestamp">{msg.timestamp}</span>
                <span className="message-platform">{msg.platform}</span>
                <span className="message-user">{msg.user}</span>
                <span className="message-text">{msg.message}</span>
              </div>
            ))}
          </div>
          
          <form onSubmit={handleSendMessage} className="chat-input-container">
            <input
              type="text"
              placeholder="Send a message"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              disabled={!isStreaming}
              className="chat-input"
            />
            <button 
              type="submit" 
              disabled={!isStreaming || !newMessage.trim()} 
              className="chat-send-button"
            >
              Send
            </button>
          </form>
        </div>

        <div className="stream-controls">
          <div className="status-panel">
            <h3>Stream Status</h3>
            <div className={`status-indicator ${isStreaming ? "live" : "ready"}`}>
              {statusMessage}
            </div>
          </div>

          <div className="viewer-panel">
            <h3>Viewer Count</h3>
            <div className="viewer-stats">
              {Object.entries(viewerCount).map(([platform, count]) => (
                <div key={platform} className="viewer-stat">
                  <span>{platform}: </span>
                  <span>{count}</span>
                </div>
              ))}
              <div className="viewer-stat">
                <span>Total: </span>
                <span>{Object.values(viewerCount).reduce((sum, count) => sum + count, 0)}</span>
              </div>
            </div>
          </div>

          <div className="rtmp-section">
            <label>RTMP URL</label>
            <textarea
              className="rtmp-input"
              placeholder="Enter your RTMP URL (e.g., rtmp://...)"
              value={rtmpUrls}
              onChange={(e) => setRtmpUrls(e.target.value)}
              disabled={isStreaming}
            />

          </div>

          <button
            onClick={isStreaming ? stopStreaming : startStreaming}
            className={`stream-button ${isStreaming ? "stop" : "start"}`}
            disabled={!mediaStream}
          >
            {isStreaming ? "End Stream" : "Go Live"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default StreamyardClone;