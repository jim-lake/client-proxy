'use strict';

if (require('semver').lt(process.version,'4.1.1')) {
  console.error("Your node version:",process.version);
  console.error("this app requires node 4.1.1 or greater.");
  process.exit(-1);
}

const express = require('express');
const http = require('http');
const morgan = require('morgan');
const method_override = require('method-override');
const body_parser = require('body-parser');
const cookie_parser = require('cookie-parser');
const errorhandler = require('errorhandler');

const routes = require('./routes');

const config = require('./config.json')

http.STATUS_CODES[460] = 'Not Allowed';

const app = express();

const is_development = app.get('env') == 'development';

app.enable('trust proxy')

app.set('port', process.env.PORT || 3000);

if (is_development ) {
  app.use(morgan('[:date] :method :url :status :res[content-length] - :response-time ms'));
} else {
  app.use(morgan(':remote-addr - - [:date] ":method :url HTTP/:http-version" :status :response-time(ms) ":referrer" ":user-agent"'));
}
app.use(allow_cross_domain);
app.use(body_parser.json());
app.use(body_parser.urlencoded({ extended: false }));
app.use(cookie_parser());
app.use(method_override());

app.use(routes.router);

app.get('/status_check',(req,res) => { res.sendStatus(200); } );

if (config.server_control_secret) {
  const server_control = require('server-control');
  server_control.init(app,{
    prefix: '/',
    repo_url: 'git@github.com:jim-lake/client-proxy.git',
    service_port: 80,
    http_proto: 'http',
    secret: config.server_control_secret,
  });
}

if (is_development) {
  app.all('/quit',(req,res) => {
    process.exit(0);
  });
}

app.use(my_error_handler);

http.createServer(app).listen(app.get('port'),() => {
  console.log('Express server listening on port ' + app.get('port'));
});

function allow_cross_domain(req,res,next) {
  if (req.headers.origin || req.method == 'OPTIONS') {
    res.header("Access-Control-Allow-Credentials","true");
    if (req.headers.origin) {
      res.header("Access-Control-Allow-Origin",req.headers.origin);
    } else {
      res.header("Access-Control-Allow-Origin","*");
    }
    res.header("Access-Control-Allow-Methods","GET,PUT,POST,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers",
      "Content-Type,Accept,X-Requested-With,X-HTTP-Method-Override,X-User-Session-Key,X-Admin-Session-Key");
  }
  if (req.method == 'OPTIONS') {
    res.sendStatus(204);
  } else {
    next();
  }
}

function my_error_handler(err,req,res,next) {
  if (err && err.code && err.body && typeof err.code === 'number') {
    res.header("Cache-Control", "no-cache, no-store, must-revalidate");
    res.header("Content-Type","text/plain");
    res.status(err.code).send(err.body.toString());
  } else if (is_development) {
    errorhandler()(err,req,res,next);
  } else {
    console.error("Middleware err:",err);
    res.header("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendStatus(500);
  }
}
