const express = require("express");
const http = require("http");
const path = require("path");
const mongoose = require("mongoose");

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