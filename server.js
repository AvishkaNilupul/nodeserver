const express = require("express");

const app = express();

app.get("/", (req, res) => {
    res.send("WORKING");
});

app.listen(3000, "0.0.0.0", () => {
    console.log("Listening on port 3000");
});