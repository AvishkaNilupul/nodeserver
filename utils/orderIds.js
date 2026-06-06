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

    console.log(
      "ORDER FILE:",
      orderIdsFile
    );

    console.log(
      "FILE EXISTS:",
      fs.existsSync(
        orderIdsFile
      )
    );

    const raw =

      fs.readFileSync(

        orderIdsFile,

        "utf8"

      );

    console.log(
      "RAW FILE:",
      raw
    );

    return JSON.parse(
      raw
    );

  }

  catch(err){

    console.log(
      "LOAD ERROR:",
      err
    );

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