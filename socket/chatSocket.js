const joinedUsers =
  new Set();

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

  io.emit(

    "new-message",

    {

      userId,

      sender:"user",

      message:"__joined__"

    }

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