const app = require("../app");

const demoAuthMiddleware = (req, res, next) => {
  const userId = req.headers["x-user-id"];
  console.log(userId);

  if (!userId) {
    return res.status(401).json({
      error: "unauthorized",
      message:
        "demo stand-in missing the x-user-id , pass it in it as its just a demo implementation ",
    });
  }

  req.userId = userId;
  next();
};

module.exports = { demoAuthMiddleware };
