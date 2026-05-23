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

    const ok =

      await bcrypt.compare(

        password,

        process.env
          .ADMIN_HASH

      );

    if(!ok){

      return res
      .status(401)
      .json({

        success:false

      });

    }

    req.session.admin =
      true;

    res.json({

      success:true

    });

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