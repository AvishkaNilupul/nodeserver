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

module.exports = {

  loadInventory,

  saveInventory

};