const express =
  require(
    "express"
  );
const {

  loadAdmins

} = require(

  "../utils/admins"

);
const bcrypt =
  require(
    "bcrypt"
  );

const router =
  express.Router();

router.post(

  "/admin-login",

  async (req,res)=>{

    console.log({

      headers:
        req.headers,

      body:
        req.body

    });

    try{

      const password =

        req.body?.password;

      if(

        !password

      ){

        return res
          .status(400)
          .json({

            success:false,

            message:
              "Password required"

          });

      }

const username =

  req.body?.username;

if(

  !username

){

  return res
    .status(400)
    .json({

      success:false,

      message:
        "Username required"

    });

}

console.log(
  "Username received:",
  username
);

console.log(
  "All admins:",
  loadAdmins()
);

const admin =

  loadAdmins().find(

    a =>

      a.username === username

  );

console.log(
  "Found admin:",
  admin
);

if(

  !admin

){

  return res
    .status(401)
    .json({

      success:false,

      message:
        "Invalid credentials"

    });

}
const ok =

  await bcrypt.compare(

    password,

    admin.password

  );
console.log({

  username,

  passwordReceived:
    password,

  compareResult:
    ok

});

      if(!ok){

        return res
          .status(401)
          .json({

            success:false,

            message:
              "Invalid password"

          });

      }

req.session.admin = {

  id:
    admin.id,

  username:
    admin.username

};

      res.json({

        success:true

      });

    }

    catch(err){

      console.error(

        "Admin login error:",

        err

      );

      res.status(500)

      .json({

        success:false,

        message:
          "Server error"

      });

    }

  }

);

router.post(

  "/admin-logout",

  (req,res)=>{

    req.session.destroy(

      (err)=>{

        if(err){

          return res
            .status(500)
            .json({

              success:false

            });

        }

        res.clearCookie(

          "connect.sid"

        );

        res.json({

          success:true

        });

      }

    );

  }

);

module.exports =
  router;