const express = require("express");
const http = require("http");
const path = require("path");
const mongoose = require("mongoose");

function requireAdmin(

  req,
  res,
  next

){

  if(

    req.session?.admin

  ){

    return next();

  }

  if(

    req.accepts(
      "html"
    )

  ){

    return res.redirect(
      "/admin-login.html"
    );

  }

  return res
    .status(401)
    .json({

      success:false,

      message:
        "Unauthorized"

    });

}


const fs =
  require("fs");

app.get(

  "/test-log",

  requireAdmin,

  (req,res)=>{

    try{

      const data =

        fs.readFileSync(

          "/root/logs/logs-TwitchUser-an4yqq57xti7.log",

          "utf8"

        );

      res.send(
        `<pre>${data}</pre>`
      );

    }

    catch(err){

      res.json({

        success:false,

        error:
          err.message

      });

    }

  }

);

const multer =
  require(
    "multer"
  );

const adminAuthRoutes =
  require(
    "./routes/adminAuthRoutes"
  );

const session =
  require(
    "express-session"
  );

require('dotenv').config();
const axios = require('axios');

const helmet =
  require("helmet");

const validator =
  require("validator");

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
const itemRoutes =
  require(
    "./routes/itemRoutes"
  );
const chatSocket =
  require("./socket/chatSocket");

const app =
  express();

const upload =

  multer({

    dest:
      "public/uploads/",

    limits:{

      fileSize:

        5
        *
        1024
        *
        1024

    }

  });

app.use(

  session({

    secret:

      process.env
        .SESSION_SECRET,

    resave:false,

    saveUninitialized:false,

    cookie:{

      httpOnly:true,

      secure:"auto",

      sameSite:"strict",

      maxAge:

        1000
        *
        60
        *
        60
        *
        12

    }

  })

);

app.disable(
  "x-powered-by"
);


app.set(
  "trust proxy",
  true
);

const server =
  http.createServer(app);

const io =
  new Server(

    server,

    {

      maxHttpBufferSize:

        1e5

    }

  );

let globalEntries = [];

const MAX_USERS = 5;

const WINDOW_MS =
  10 * 60 * 1000;

// =========================
// Middleware

// =========================

app.post(

  "/upload-image",


  upload.single(
    "image"
  ),

  (req,res)=>{

    if(

      !req.file

    ){

      return res
        .status(400)
        .json({

          success:false

        });

    }

    res.json({

      success:true,

      url:

        `/uploads/${req.file.filename}`

    });

  }

);

app.use(

  helmet({

    contentSecurityPolicy:false

  })

);

app.use(

  express.json({

    limit:"100kb"

  })

);

app.use(

  express.urlencoded({

    extended:true,

    limit:"100kb"

  })

);

app.use(
  adminAuthRoutes
);

app.get(

  "/admin.html",

  requireAdmin,

  (req,res)=>{

    res.sendFile(

      path.join(

        __dirname,

        "public",

        "admin.html"

      )

    );

  }

);
app.get(

  "/items",

  requireAdmin,

  (req,res)=>{

    res.sendFile(

      path.join(

        __dirname,

        "admin-pages",

        "items.html"

      )

    );

  }

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
app.use(

  requireAdmin,

  itemRoutes

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

    let { gamerTag } =
        req.body;

      gamerTag =

        validator
          .escape(

            String(
              gamerTag || ""
            )

          )
          .trim();

    // =========================
    // Global Limit
    // =========================

    const now =
      Date.now();

    // remove expired

    globalEntries =

      globalEntries.filter(

        time =>

          now - time
          <
          WINDOW_MS

      );

    // limit reached

    if(

      globalEntries.length
      >=
      MAX_USERS

    ){

      return res.status(429)

      .json({

        success:false,

        message:

          "Server busy. Please try again later."

      });

    }

    // consume slot

    globalEntries.push(
      now
    );

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
        "cf-connecting-ip"
      ]

      ||

      req.headers[
        "x-forwarded-for"
      ]?.split(",")[0]

      ||

      req.socket
        .remoteAddress

      ||

      "Unknown";

      console.log({

        cf:

          req.headers[
            "cf-connecting-ip"
          ],

        forwarded:

          req.headers[
            "x-forwarded-for"
          ],

        remote:

          req.socket
            .remoteAddress,

        finalIp:
          ip

      });

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