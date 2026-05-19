const express = require("express");
const http = require("http");
const path = require("path");
const mongoose = require("mongoose");

require('dotenv').config();
const axios = require('axios');

const { Server } =
  require("socket.io");

const config =
  require("./config/config");

const authRoutes =
  require("./routes/authRoutes");

const redeemRoutes =
  require("./routes/redeemRoutes");

const chatRoutes =
  require("./routes/chatRoutes");

const chatSocket =
  require("./socket/chatSocket");

const app =
  express();

const server =
  http.createServer(app);

const io =
  new Server(server);

// =========================
// Middleware
// =========================

app.use(
  express.json()
);

app.use(
  express.urlencoded({

    extended:true

  })
);

app.use(

  express.static(

    path.join(
      __dirname,
      "public"
    )

  )

);

// =========================
// MongoDB
// =========================

mongoose.connect(

  config.MONGO_URI

)

.then(()=>{

  console.log(

    "✅ MongoDB connected"

  );

})

.catch((err)=>{

  console.error(

    "❌ MongoDB connection error:",

    err

  );

});

// =========================
// Home Route
// =========================

app.get(
  "/",
  (req,res)=>{

    res.sendFile(

      path.join(

        __dirname,

        "public",

        "index.html"

      )

    );

  }
);

// =========================
// Routes
// =========================

app.use(
  authRoutes
);

app.use(
  redeemRoutes
);

app.use(
  chatRoutes
);

// =========================
// Socket.IO
// =========================

chatSocket(
  io
);

// =========================
// 404
// =========================

// =========================
// Telegram GamerTag Route
// =========================

app.post("/submit-gamertag", async (req,res)=>{

  try{

    const { gamerTag } =
      req.body;

    if(!gamerTag){

      return res.status(400)
      .json({

        success:false,

        message:
          "Missing gamer tag"

      });

    }

    const ip =

      req.headers[
        'x-forwarded-for'
      ] ||

      req.socket
        .remoteAddress;

    const chatIds =

      process.env
        .TG_CHAT_IDS
        .split(",");

    for(const chatId of chatIds){

      await axios.post(

        `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,

        {

          chat_id:
            chatId.trim(),

          text:
`🎮 NEW GAMER TAG

Tag: ${gamerTag}

IP: ${ip}

Time:
${new Date().toISOString()}`

        }

      );

    }

    res.json({

      success:true

    });

  }

  catch(err){

    console.error(

      "Telegram error:",

      err.response?.data ||

      err.message

    );

    res.status(500)

    .json({

      success:false

    });

  }

});

app.use(
  (req,res)=>{

    res.status(404)

    .json({

      success:false,

      message:
        "Route not found"

    });

  }
);

// =========================
// Start Server
// =========================

server.listen(

  config.PORT,

  "0.0.0.0",

  ()=>{

    console.log(

      `🚀 Server started on http://0.0.0.0:${config.PORT}`

    );

  }

);