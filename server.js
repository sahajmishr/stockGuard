const app = require('./src/app');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });


const PORT = process.env.PORT || 8001;

const server = app.listen(PORT , ()=>{
  console.log(`server started successfully over port ${PORT}`);
});

process.on('SIGTERM',()=>{
  console.log(`got SIGTERM initiating gracefull shutdown.....`);
  server.close(()=>{
    console.log(`server terminated successfully .`);
  });
});

