const {app} = require('../app');

const validateSkuParams = (req , res ,next)=>{
    const {id} = req.params ;

    const parsedId = parseInt(id , 10);

    if(isNaN(parsedId) || parsedId <= 0){
       res.status(400).json({message : " tum chor ho "}); 
    }
    req.validatedId = parsedId;
    next();
}
module.exports ={ validateSkuParams };