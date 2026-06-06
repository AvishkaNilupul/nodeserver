const fs =
  require("fs");

const path =
  require("path");

const orderIdsFile =

  path.join(

    __dirname,

    "../orderIds.json"

  );

if(

  !fs.existsSync(
    orderIdsFile
  )

){

  fs.writeFileSync(

    orderIdsFile,

    "[]"

  );

}

function loadOrderIds(){

  try{

    return JSON.parse(

      fs.readFileSync(

        orderIdsFile,

        "utf8"

      )

    );

  }

  catch{

    return [];

  }

}

function saveOrderIds(

  orderIds

){

  fs.writeFileSync(

    orderIdsFile,

    JSON.stringify(

      orderIds,

      null,
      2

    )

  );

}

module.exports = {

  loadOrderIds,

  saveOrderIds

};