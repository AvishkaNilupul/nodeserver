const express =
  require("express");

const router =
  express.Router();

const {

  loadOrderIds,
  saveOrderIds

} = require(
  "../utils/orderIds"
);

// ====================
// GET ALL
// ====================

router.get(

  "/orders/list",

  (req,res)=>{

    res.json(

      loadOrderIds()

    );

  }

);

// ====================
// ADD ORDER
// ====================

router.post(

  "/orders/add",

  (req,res)=>{

    const {

      orderId

    } = req.body;

    if(

      !orderId

    ){

      return res
        .status(400)
        .json({

          success:false

        });

    }

    const orders =

      loadOrderIds();

    orders.push({

      id:
        Date.now()
        .toString(),

      orderId:
        orderId.trim(),

      used:false,

      gamerTag:null,

      usedAt:null,

      createdAt:
        Date.now()

    });

    saveOrderIds(
      orders
    );

    res.json({

      success:true

    });

  }

);

// ====================
// DELETE
// ====================

router.delete(

  "/orders/delete/:id",

  (req,res)=>{

    let orders =

      loadOrderIds();

    orders =

      orders.filter(

        o=>

          o.id
          !==
          req.params.id

      );

    saveOrderIds(
      orders
    );

    res.json({

      success:true

    });

  }

);

module.exports =
  router;