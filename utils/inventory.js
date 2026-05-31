const fs =
  require("fs");

const path =
  require("path");

const inventoryFile =

  path.join(

    __dirname,

    "../inventory.json"

  );

if(

  !fs.existsSync(
    inventoryFile
  )

){

  fs.writeFileSync(

    inventoryFile,

    "[]"

  );

}

function loadInventory(){

  try{

    return JSON.parse(

      fs.readFileSync(

        inventoryFile,

        "utf8"

      )

    );

  }

  catch{

    return [];

  }

}

function saveInventory(

  inventory

){

  fs.writeFileSync(

    inventoryFile,

    JSON.stringify(

      inventory,

      null,
      2

    )

  );

}
// ====================
// MARK UNUSED
// ====================

router.post(

  "/inventory/mark-unused/:id",

  (req,res)=>{

    const inventory =

      loadInventory();

    const item =

      inventory.find(

        i=>

          i.id
          ===
          req.params.id

      );

    if(

      !item

    ){

      return res
        .status(404)
        .json({

          success:false

        });

    }

    item.used =
      false;

    item.usedAt =
      null;

    saveInventory(
      inventory
    );

    res.json({

      success:true

    });

  }

);

// ====================
// DELETE ACCOUNT
// ====================

router.delete(

  "/inventory/delete/:id",

  (req,res)=>{

    let inventory =

      loadInventory();

    inventory =

      inventory.filter(

        item=>

          item.id
          !==
          req.params.id

      );

    saveInventory(
      inventory
    );

    res.json({

      success:true

    });

  }

);
module.exports = {

  loadInventory,

  saveInventory

};