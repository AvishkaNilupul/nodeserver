const express =
  require(
    "express"
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

      if(

        !process.env
          .ADMIN_HASH

      ){

        return res
          .status(500)
          .json({

            success:false,

            message:
              "Server config error"

          });

      }

      const ok =

        await bcrypt.compare(

          password,

          process.env
            .ADMIN_HASH

        );

      console.log({

        receivedPassword:
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

      req.session.admin =
        true;

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

      ()=>{

        res.json({

          success:true

        });

      }

    );

  }

);

module.exports =
  router;