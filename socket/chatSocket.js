const joinedUsers =
  new Set();
const {
  loadOrderIds
} = require(
  "../utils/orderIds"
);
const cooldowns =
  new Map();
const validator =
  require(
    "validator"
  );

require('dotenv').config();
const axios =
  require('axios');

const {

  loadMessages,
  saveMessages,
  addMessage

} = require(
  "../utils/messages"
);

function chatSocket(
  io
) {

  io.on(

    "connection",

    (socket)=>{

      console.log(
        "✅ Connected:",
        socket.id
      );

      // =========================
      // Join User
      // =========================

      socket.on(

        "join-user",

        (userId)=>{

          if(

            typeof userId
            !==
            "string"

          ){

            return;

          }

          userId =

            validator.escape(

              userId
                .trim()
                .slice(0,50)

            );

          if(!userId){

            return;

          }

          socket.join(
            userId
          );

          console.log(
            "👤 Joined:",
            userId
          );

          // tell admin immediately

if(

  !joinedUsers.has(
    userId
  )

){

  joinedUsers.add(
    userId
  );

}


          let messages =
            loadMessages();

          // welcome check

          const hasWelcome =

            messages.some(

              msg=>

                msg.userId
                ===
                userId

                &&

                msg.message
                ===

                "Wait for admin to contact you to deliver your items in-game."

            );

          // create welcome once

if(!hasWelcome){

  addMessage(

    userId,

    "admin",

    "Wait for admin to contact you to deliver your items in-game."

  );

  const orders =
    loadOrderIds();

  const order =

    orders.find(

      o =>

        o.gamerTag === userId

        &&

        o.used

        &&

        o.username

        &&

        o.password

    );

  if(order){
addMessage(

  userId,

  "admin",

`📋 TWITCH DROP GUIDE

🔑 Login

User: ${order.username}
Pass: ${order.password}

1. Log in → https://www.twitch.tv/drops/inventory

Scroll down to the "Received" section.

2. Press the purple "Connect" button below your item.

3. Follow the connection instructions shown on the linked site.

4. Some games require extra steps.

Rust:
• Activate Drops
• Check for missing drops`

);

  }

  messages =
    loadMessages();

}

          // user history

          const userMessages =

            messages.filter(

              msg=>

                msg.userId
                ===
                userId

            );

          socket.emit(

            "chat-history",

            userMessages

          );

        }

      );

      // =========================
      // User Message
      // =========================

      socket.on(

        "user-message",

        async (data)=>{

          if(

            !data

            ||

            typeof data.userId
            !==
            "string"

            ||

            typeof data.message
            !==
            "string"

          ){

            return;

          }

          data.userId =

            validator.escape(

              data.userId
                .trim()
                .slice(0,50)

            );

          data.message =

            String(
              data.message
            )
              .trim()
              .slice(0,1000);

          if(!data.message){

            return;

          }
          const key =

            `${socket.id}`;


          const now =
            Date.now();

          const last =

            cooldowns.get(
              key
            );

          if(

            last

            &&

            now - last
            < 1000

          ){

            return;

          }

          cooldowns.set(

            key,

            now

          );

          addMessage(

            data.userId,

            "user",

            data.message

          );
        // =========================
        // Telegram Chat Alert
        // =========================

          try{

              const chatIds =

                process.env
                  .TG_CHAT_IDS

                  ?

                  process.env
                    .TG_CHAT_IDS
                    .split(",")

                  :

                  [];

            for(const chatId of chatIds){

              await axios.post(

                `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,

                {

                  chat_id:
                    chatId.trim(),

text:
`💬 NEW CHAT MESSAGE

👤 User:
${data.userId}

📝 Message:
${data.message}

Time:
${new Date().toISOString()}`

                }

              );

            }

          }

          catch(err){

            console.error(

              "Telegram chat error:",

              err.response?.data ||

              err.message

            );

          }

          

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
// Typing Indicator
// =========================

socket.on(

  "admin-typing",

  (userId)=>{

    if(

      typeof userId
      !==
      "string"

    ){

      return;

    }

    io.to(

      userId

    ).emit(

      "support-typing"

    );

  }

);

socket.on(

  "admin-stop-typing",

  (userId)=>{

    if(

      typeof userId
      !==
      "string"

    ){

      return;

    }

    io.to(

      userId

    ).emit(

      "support-stop-typing"

    );

  }

);

// =========================
// User Typing
// =========================

socket.on(

  "user-typing",

  (userId)=>{

    if(

      typeof userId
      !==
      "string"

    ){

      return;

    }

    io.emit(

      "user-typing",

      userId

    );

  }

);

socket.on(

  "user-stop-typing",

  (userId)=>{

    if(

      typeof userId
      !==
      "string"

    ){

      return;

    }

    io.emit(

      "user-stop-typing",

      userId

    );

  }

);

// =========================
// Message Seen
// =========================

socket.on(

  "message-seen",

  (userId)=>{

    if(

      typeof userId
      !==
      "string"

    ){

      return;

    }

    const messages =
      loadMessages();

    let changed =
      false;

    messages.forEach(

      (msg)=>{

        if(

          msg.userId===userId

          &&

          msg.sender==="admin"

        ){

          msg.seen =
            true;

          changed =
            true;

        }

      }

    );

    if(changed){

      saveMessages(
        messages
      );

    }

    io.emit(

      "message-seen",

      userId

    );

  }

);
      // =========================
      // Admin Message
      // =========================

      socket.on(

        "admin-message",

        (data)=>{

          if(

            !data

            ||

            typeof data.userId
            !==
            "string"

            ||

            typeof data.message
            !==
            "string"

          ){

            return;

          }

          data.userId =

            validator.escape(

              data.userId
                .trim()
                .slice(0,50)

            );

          data.message =

            String(

              data.message
            )
            .trim()
            .slice(0,1000);
            const key =

              `admin-${socket.id}`;

            const now =
              Date.now();

            const last =

              cooldowns.get(
                key
              );

            if(

              last

              &&

              now - last
              < 300

            ){

              return;

            }

            cooldowns.set(
              key,
              now
            );

          addMessage(

            data.userId,

            "admin",

            data.message

          );

          io.to(
            data.userId
          )

          .emit(

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

        ()=>{

          cooldowns.delete(
            socket.id
          );

          cooldowns.delete(
            `admin-${socket.id}`
          );

          console.log(
            "❌ Disconnected:",
            socket.id
          );

        }

      );
          }

  );

}


module.exports =
  chatSocket;