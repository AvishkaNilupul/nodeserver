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
const inventoryRoutes =
  require(
    "./routes/inventoryRoutes"
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
const {

  loadOrderIds,
  saveOrderIds

} = require(
  "./utils/orderIds"
);
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
app.get(

  "/test-log",

  requireAdmin,

  (req,res)=>{

    const fs =
      require("fs");

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
app.post("/submit-gamertag", async (req,res)=>{

  try{
    console.log("SUBMIT REQUEST");
console.log(req.body);

    let {

      gamerTag,
      orderId

    } = req.body;

    gamerTag =

      validator
        .escape(

          String(
            gamerTag || ""
          )

        )

        .trim();

    orderId =

      String(
        orderId || ""
      )

      .trim();

    // =========================
    // Global Limit
    // =========================

    const now =
      Date.now();

    globalEntries =

      globalEntries.filter(

        time =>

          now - time
          <
          WINDOW_MS

      );

    if(

      globalEntries.length
      >=
      MAX_USERS

    ){

      return res
        .status(429)
        .json({

          success:false,

          message:
            "Server busy. Please try again later."

        });

    }

    globalEntries.push(
      now
    );

    // =========================
    // Validation
    // =========================

    if(

      !gamerTag

      ||

      !orderId

    ){

      return res
        .status(400)
        .json({

          success:false,

          message:
            "Missing gamer tag or order ID"

        });

    }
    console.log("LOADING ORDER IDS");

    const orderIds =

      loadOrderIds();
      console.log(orderIds);

    const order =

      orderIds.find(

        o=>

          o.orderId
          ===
          orderId

      );

    if(

      !order

    ){

      return res
        .status(400)
        .json({

          success:false,

          message:
            "Invalid Order ID"

        });

    }

    if(

      order.used

    ){

      return res
        .status(400)
        .json({

          success:false,

          message:
            "Order ID already used"

        });

    }

    // =========================
    // IP
    // =========================

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

    // =========================
    // Telegram
    // =========================

    const chatIds =

      process.env
        .TG_CHAT_IDS
        .split(",");

    for(

      const chatId

      of

      chatIds

    ){

      await axios.post(

        `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,

        {

          chat_id:
            chatId.trim(),

          text:
`🎮 NEW GAMER TAG

Tag: ${gamerTag}

Order ID:
${orderId}

IP:
${ip}

Time:
${new Date().toISOString()}`

        }

      );

    }

    // =========================
    // Mark Order Used
    // =========================

    order.used =
      true;

    order.gamerTag =
      gamerTag;

    order.usedAt =
      Date.now();

    saveOrderIds(
      orderIds
    );

    res.json({

      success:true

    });

  }

  catch(err){

console.error(
  "SUBMIT ERROR:"
);

console.error(err);

console.error(
  err.stack
);

    res.status(500)

    .json({

      success:false

    });

  }

});
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
app.get(

  "/inventory",

  requireAdmin,

  (req,res)=>{

    res.sendFile(

      path.join(

        __dirname,

        "admin-pages",

        "inventory.html"

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
app.use(

  requireAdmin,

  inventoryRoutes

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