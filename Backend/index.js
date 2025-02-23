const http = require("http");
const express = require("express");
const SocketIO = require("socket.io").Server;
const { spawn } = require("child_process");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: "*" } });
const port = process.env.PORT || 4000;

const defaultOauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  "http://localhost:4000/oauth2callback"
);

defaultOauth2Client.setCredentials({
  access_token: process.env.YOUTUBE_ACCESS_TOKEN,
  refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
});

console.log("Default OAuth2Client credentials:", defaultOauth2Client.credentials);

const oauthClients = new Map();
let ffmpegProcesses = new Map();
let liveChatPolling = new Map();

const getAuthUrl = () => {
  return defaultOauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/youtube.readonly"],
  });
};

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  try {
    const { tokens } = await defaultOauth2Client.getToken(code);
    console.log("New Access Token:", tokens.access_token);
    console.log("New Refresh Token (save this!):", tokens.refresh_token);
    res.send("Authorization successful! Check server logs for tokens.");
  } catch (error) {
    console.error("OAuth error:", error.message);
    res.status(500).send("OAuth failed");
  }
});

const startFFmpeg = (urls, socketId) => {
  if (!Array.isArray(urls) || urls.length === 0) {
    console.error(`Invalid or missing RTMP URLs for ${socketId}`);
    io.to(socketId).emit("stream_status", { status: "error", message: "No valid RTMP URLs provided" });
    return null;
  }

  if (ffmpegProcesses.has(socketId)) {
    const oldProcess = ffmpegProcesses.get(socketId);
    oldProcess.stdin.end();
    oldProcess.kill("SIGINT");
    ffmpegProcesses.delete(socketId);
    console.log(`Stopped previous FFmpeg process for ${socketId}`);
  }

  const ffmpeg = spawn("ffmpeg", [
    "-re",
    "-i",
    "pipe:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    "1000k",
    "-maxrate",
    "1000k",
    "-bufsize",
    "2000k",
    "-g",
    "30",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-f",
    "tee",
    "-map",
    "0:v",
    "-map",
    "0:a",
    urls.map((url) => `[f=flv:onfail=ignore]${url}`).join("|"),
  ]);

  ffmpeg.stderr.on("data", (data) => console.log(`[FFmpeg ${socketId}] ${data}`));
  ffmpeg.on("exit", () => {
    ffmpegProcesses.delete(socketId);
    io.to(socketId).emit("stream_status", { status: "stopped", message: "Stream ended" });
  });
  ffmpegProcesses.set(socketId, ffmpeg);
  io.to(socketId).emit("stream_status", { status: "started", message: `Streaming to ${urls.length} destination(s)` });
  return ffmpeg;
};

const fetchYouTubeLiveChat = async (socketId, oauthClient) => {
  const youtube = google.youtube({ version: "v3", auth: oauthClient });

  if (liveChatPolling.has(socketId)) {
    clearInterval(liveChatPolling.get(socketId));
    liveChatPolling.delete(socketId);
    console.log(`Cleared previous live chat polling for ${socketId}`);
  }

  let attempts = 0;
  const maxAttempts = 10;

  const tryFetchBroadcast = async () => {
    try {
      console.log(`Attempt ${attempts + 1}/${maxAttempts} to fetch broadcasts for socket: ${socketId}`);
      console.log(`Using credentials for ${socketId}:`, oauthClient.credentials);
      const broadcastRes = await youtube.liveBroadcasts.list({
        part: "id,snippet",
        mine: true,
        maxResults: 10,
      });

      console.log(`Full API response for ${socketId}:`, JSON.stringify(broadcastRes.data, null, 2));

      if (!broadcastRes.data.items || broadcastRes.data.items.length === 0) {
        throw new Error("No broadcasts found in response");
      }

      const activeBroadcast = broadcastRes.data.items.find(
        (item) => item.snippet.liveChatId && item.snippet.actualStartTime && !item.snippet.actualEndTime
      );

      if (!activeBroadcast) {
        console.log(`No active broadcast found for ${socketId}. All broadcasts:`, broadcastRes.data.items);
        throw new Error("No active broadcast with live chat found");
      }

      const liveChatId = activeBroadcast.snippet.liveChatId;
      console.log(`Found liveChatId for ${socketId}: ${liveChatId}`);

      let nextPageToken = null;
      const interval = setInterval(async () => {
        try {
          const chatRes = await youtube.liveChatMessages.list({
            part: "snippet,authorDetails",
            liveChatId: liveChatId,
            pageToken: nextPageToken,
          });

          const messages = chatRes.data.items.map((item) => ({
            platform: "YouTube",
            user: item.authorDetails.displayName || "Unknown",
            message: item.snippet.displayMessage || "No message",
            timestamp: new Date(item.snippet.publishedAt).toTimeString().split(" ")[0],
          }));

          console.log(`Emitting chat messages for ${socketId}:`, messages);
          io.to(socketId).emit("chat_update", messages);
          nextPageToken = chatRes.data.nextPageToken;
        } catch (error) {
          console.error(`Chat polling error for ${socketId}: ${error.message}`);
        }
      }, 5000);

      liveChatPolling.set(socketId, interval);

      setInterval(() => {
        io.to(socketId).emit("viewer_update", { YouTube: Math.floor(Math.random() * 1000) + 100 });
      }, 5000);
    } catch (error) {
      console.error(`YouTube API error for ${socketId}: ${error.message}`);
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`Retrying in 5 seconds... (${attempts}/${maxAttempts})`);
        setTimeout(tryFetchBroadcast, 5000);
      } else {
        io.to(socketId).emit("stream_status", { status: "error", message: `Failed to find active broadcast after ${maxAttempts} attempts: ${error.message}` });
      }
    }
  };

  tryFetchBroadcast();
};

io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on("set_rtmp_urls", (data) => {
    console.log(`Received data from ${socket.id}:`, data);
    const { urls, accessToken, refreshToken } = data || {};

    let oauthClient;
    if (accessToken && refreshToken) {
      oauthClient = new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET,
        "http://localhost:4000/oauth2callback"
      );
      oauthClient.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      oauthClient.on("tokens", (tokens) => {
        console.log(`New Access Token for ${socket.id}:`, tokens.access_token);
        if (tokens.refresh_token) console.log(`New Refresh Token for ${socket.id}:`, tokens.refresh_token);
      });
      oauthClients.set(socket.id, oauthClient);
      console.log(`Set custom OAuth client for ${socket.id}`);
    } else {
      oauthClient = defaultOauth2Client;
      console.log(`Using default OAuth client for ${socket.id}`);
    }

    startFFmpeg(urls, socket.id);
    fetchYouTubeLiveChat(socket.id, oauthClient);
  });

  socket.on("binarystream", (chunk) => {
    const ffmpeg = ffmpegProcesses.get(socket.id);
    if (!ffmpeg) return;
    ffmpeg.stdin.write(chunk);
  });

  socket.on("stop_streaming", () => {
    if (ffmpegProcesses.has(socket.id)) {
      const ffmpeg = ffmpegProcesses.get(socket.id);
      ffmpeg.stdin.end();
      ffmpeg.kill("SIGINT");
      ffmpegProcesses.delete(socket.id);
    }
    if (liveChatPolling.has(socket.id)) {
      clearInterval(liveChatPolling.get(socket.id));
      liveChatPolling.delete(socket.id);
    }
    console.log(`Stopped streaming for ${socket.id}`);
  });

  socket.on("disconnect", () => {
    if (ffmpegProcesses.has(socket.id)) {
      ffmpegProcesses.get(socket.id).stdin.end();
      ffmpegProcesses.get(socket.id).kill("SIGINT");
      ffmpegProcesses.delete(socket.id);
    }
    if (liveChatPolling.has(socket.id)) {
      clearInterval(liveChatPolling.get(socket.id));
      liveChatPolling.delete(socket.id);
    }
    oauthClients.delete(socket.id);
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  if (!process.env.YOUTUBE_ACCESS_TOKEN || !process.env.YOUTUBE_REFRESH_TOKEN) {
    console.log("Visit this URL to authorize default account:", getAuthUrl());
  }
});