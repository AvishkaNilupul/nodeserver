const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const { Server } = require("socket.io");

const Code = require("./models/Code");

const app = express();

const server = http.createServer(app);

const io = new Server(server);

// =========================
// CONFIG
// =========================

const ADMIN_KEY = "Avishka123";

// =========================
// Middleware
// =========================

app.use(express.json());

app.use(express.urlencoded({
  extended: true
}));

app.use(express.static(
  path.join(__dirname, "public")
));

// =========================
// MongoDB Connection
// =========================

mongoose.connect(
  "mongodb://avishka:Avishka123@ac-ufnccre-shard-00-00.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-01.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-02.vsigmq3.mongodb.net:27017/codesDB?ssl=true&replicaSet=atlas-ur8a1h-shard-0&authSource=admin&appName=redeemer"
)

.then(() => {

  console.log("✅ MongoDB connected");

})

.catch((err) => {

  console.error(
    "❌ MongoDB connection error:",
    err
  );

});

// =========================
// Messages File
// =========================

const messagesFile =
  path.join(
    __dirname,
    "messages.json"
  );

// Create file if missing

if (!fs.existsSync(messagesFile)) {

  fs.writeFileSync(
    messagesFile,
    "[]"
  );

}

// =========================
// Load Messages
// =========================

function loadMessages() {

  try {

    const data =
      fs.readFileSync(
        messagesFile,
        "utf8"
      );

    return JSON.parse(data);

  } catch {

    return [];

  }

}

// =========================
// Save Messages
// =========================

function saveMessages(messages) {

  fs.writeFileSync(

    messagesFile,

    JSON.stringify(
      messages,
      null,
      2
    )

  );

}

// =========================
// Add Message
// =========================

function addMessage(
  userId,
  sender,
  message
) {

  const messages =
    loadMessages();

  messages.push({

    userId,

    sender,

    message,

    timestamp:
      Date.now()

  });

  saveMessages(messages);

}

// =========================
// Redeem Code Generator
// =========================

function generateRedeemCode() {

  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function part(length) {

    let result = "";

    for (let i = 0; i < length; i++) {

      result += chars.charAt(

        Math.floor(
          Math.random() *
          chars.length
        )

      );

    }

    return result;

  }

  return `${part(4)}-${part(5)}-${part(4)}-${part(4)}`;

}

// =========================
// Routes
// =========================

// Home

app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );

});

// =========================
// Get Messages
// =========================

app.get("/messages", (req, res) => {

  const messages =
    loadMessages();

  res.json(messages);

});

// =========================
// Get Users
// =========================

app.get("/users", (req, res) => {

  const messages =
    loadMessages();

  const uniqueUsers =
    [...new Set(

      messages.map(
        (msg) => msg.userId
      )

    )];

  res.json(uniqueUsers);

});

// =========================
// Validate Route
// =========================

app.post("/validate", async (req, res) => {

  try {

    const {
      code,
      deviceToken
    } = req.body;

    if (!code) {

      return res.status(400).json({

        success: false,

        message:
          "Code is required"

      });

    }

    const found =
      await Code.findOne({
        code
      });

    if (!found) {

      return res.json({

        success: false,

        message:
          "Invalid code"

      });

    }

    // =========================
    // First redeem
    // =========================

    if (!found.deviceToken) {

      found.deviceToken =
        deviceToken;

      found.redeemedAt =
        new Date();

      await found.save();

    }

    // =========================
    // Different device blocked
    // =========================

    if (
      found.deviceToken !==
      deviceToken
    ) {

      return res.json({

        success: false,

        message:
          "This code has already been redeemed"

      });

    }

    // =========================
    // Expire after 2 days
    // =========================

    if (found.redeemedAt) {

      const twoDays =
        2 * 24 * 60 * 60 * 1000;

      const expired =

        Date.now() -

        new Date(
          found.redeemedAt
        ).getTime()

        > twoDays;

      if (expired) {

        return res.json({

          success: false,

          message:
            "This code has expired"

        });

      }

    }

    // =========================
    // Success
    // =========================

    return res.json({

      success: true,

      account:
        found.account,

      password:
        found.password

    });

  } catch (err) {

    console.error(
      "❌ Validate error:",
      err
    );

    return res.status(500).json({

      success: false,

      message:
        "Server error"

    });

  }

});

// =========================
// Generate Route
// =========================

app.post("/generate", async (req, res) => {

  try {

    const {
      account,
      password,
      key
    } = req.body;

    if (key !== ADMIN_KEY) {

      return res.status(403).json({

        success: false,

        message:
          "Invalid admin key"

      });

    }

    if (
      !account ||
      !password
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Account and password are required"

      });

    }

    let code;

    let exists = true;

    while (exists) {

      code =
        generateRedeemCode();

      exists =
        await Code.findOne({
          code
        });

    }

    const newCode =
      new Code({

        code,

        account,

        password

      });

    await newCode.save();

    return res.json({

      success: true,

      code

    });

  } catch (err) {

    console.error(
      "❌ Generate error:",
      err
    );

    return res.status(500).json({

      success: false,

      message:
        "Server error"

    });

  }

});

// =========================
// Socket.IO
// =========================

io.on("connection", (socket) => {

  console.log(
    "✅ Connected:",
    socket.id
  );

  // =========================
  // User joins
  // =========================

  socket.on(
    "join-user",
    (userId) => {

      socket.join(userId);

      console.log(
        "👤 Joined:",
        userId
      );

      const messages =
        loadMessages();

      const userMessages =
        messages.filter(
          (msg) =>
            msg.userId ===
            userId
        );

      socket.emit(
        "chat-history",
        userMessages
      );

    }
  );

  // =========================
  // Customer message
  // =========================

  socket.on(
    "user-message",
    (data) => {

      addMessage(

        data.userId,

        "user",

        data.message

      );

      io.emit(
        "new-message",
        {

          userId:
            data.userId,

          sender:
            "user",

          message:
            data.message

        }
      );

    }
  );

  // =========================
  // Admin message
  // =========================

  socket.on(
    "admin-message",
    (data) => {

      addMessage(

        data.userId,

        "admin",

        data.message

      );

      io.to(
        data.userId
      ).emit(
        "admin-reply",
        {

          message:
            data.message

        }
      );

      io.emit(
        "new-message",
        {

          userId:
            data.userId,

          sender:
            "admin",

          message:
            data.message

        }
      );

    }
  );

  // =========================
  // Disconnect
  // =========================

  socket.on(
    "disconnect",
    () => {

      console.log(
        "❌ Disconnected:",
        socket.id
      );

    }
  );

});

// =========================
// 404
// =========================

app.use((req, res) => {

  res.status(404).json({

    success: false,

    message:
      "Route not found"

  });

});

// =========================
// Start Server
// =========================

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Server started on http://0.0.0.0:${PORT}`
    );

  }
);