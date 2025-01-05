const express = require("express");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URI = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// Store active connections
const connections = new Map();

class GeminiConnection {
  constructor() {
    this.apiKey = GEMINI_API_KEY;
    this.model = "gemini-2.0-flash-exp";
    this.ws = null;
    this.config = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(GEMINI_URI, { headers: { "Content-Type": "application/json" } });

      this.ws.on("open", () => {
        if (!this.config) {
          reject(new Error("Configuration must be set before connecting"));
        }

        const setupMessage = {
          setup: {
            model: `models/${this.model}`,
            generation_config: {
              response_modalities: ["AUDIO"],
              speech_config: {
                voice_config: {
                  prebuilt_voice_config: {
                    voice_name: this.config.voice,
                  },
                },
              },
            },
            system_instruction: {
              parts: [
                {
                  text: this.config.systemPrompt,
                },
              ],
            },
          },
        };

        this.ws.send(JSON.stringify(setupMessage));

        this.ws.once("message", (message) => {
          resolve(JSON.parse(message));
        });
      });

      this.ws.on("error", (error) => reject(error));
    });
  }

  setConfig(config) {
    this.config = config;
  }

  sendAudio(audioData) {
    const message = {
      realtime_input: {
        media_chunks: [
          {
            data: audioData,
            mime_type: "audio/pcm",
          },
        ],
      },
    };
    this.ws.send(JSON.stringify(message));
  }

  sendImage(imageData) {
    const message = {
      realtime_input: {
        media_chunks: [
          {
            data: imageData,
            mime_type: "image/jpeg",
          },
        ],
      },
    };
    this.ws.send(JSON.stringify(message));
  }

  sendText(text) {
    const message = {
      client_content: {
        turns: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        turn_complete: true,
      },
    };
    this.ws.send(JSON.stringify(message));
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }

  onMessage(callback) {
    this.ws.on("message", (message) => callback(JSON.parse(message)));
  }
}

wss.on("connection", (ws) => {
  const clientId = uuidv4();
  let gemini;

  ws.on("message", async (message) => {
    try {
      const parsedMessage = JSON.parse(message);

      if (parsedMessage.type === "config") {
        gemini = new GeminiConnection();
        gemini.setConfig(parsedMessage.config);
        await gemini.connect();
        connections.set(clientId, gemini);
      } else if (parsedMessage.type === "audio") {
        gemini.sendAudio(parsedMessage.data);
      } else if (parsedMessage.type === "image") {
        gemini.sendImage(parsedMessage.data);
      } else if (parsedMessage.type === "text") {
        gemini.sendText(parsedMessage.data);
      }
    } catch (error) {
      console.error("Error processing message: ", error);
      ws.send(JSON.stringify({ type: "error", message: error.message }));
    }
  });

  if (gemini) {
    gemini.onMessage((response) => {
      try {
        if (response.serverContent && response.serverContent.modelTurn) {
          const parts = response.serverContent.modelTurn.parts;

          for (const part of parts) {
            if (part.inlineData) {
              ws.send(
                JSON.stringify({
                  type: "audio",
                  data: part.inlineData.data,
                })
              );
            } else if (part.text) {
              ws.send(
                JSON.stringify({
                  type: "text",
                  data: part.text,
                })
              );
            }
          }
        }

        if (response.serverContent && response.serverContent.turnComplete) {
          ws.send(
            JSON.stringify({
              type: "turn_complete",
              data: true,
            })
          );
        }
      } catch (error) {
        console.error("Error sending message to client: ", error);
      }
    });
  }

  ws.on("close", () => {
    if (connections.has(clientId)) {
      connections.get(clientId).close();
      connections.delete(clientId);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error: ", error);
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
