'use strict';

const _ = require('lodash');
const async = require('async');
const express = require('express');
const fs = require('fs');
const exec = require('child_process').exec;

const config = require('../config.json');

const router = new express.Router();

exports.router = router;


router.get('/api/1/config',get_config);

router.all('/api/1/proxy/:ip/set',set_proxy);
router.all('/api/1/proxy/:ip/clear',clear_proxy);

function get_config(req,res) {
  res.header("Cache-Control", "no-cache, no-store, must-revalidate");

  read_config((err,server_config) => {
    if (err) {
      res.sendStatus(500);
    } else {
      const server_list = config.preset_server_list
      server_config.client_ip = req.ip.replace(/^.*:/,'');
      server_config.server_list = server_list;
      _.each(server_config.ip_proxy_map,(url,ip) => {
        const server = _.findWhere(server_list,{ url });
        if (server) {
          server_config.ip_proxy_map[ip] = server;
        }
      });
      const default_server = _.findWhere(server_list,{ url: server_config.default_proxy });
      server_config.default_proxy = default_server || server_config.default_proxy;
      res.send(server_config);
    }
  });
}

function set_proxy(req,res) {
  res.header("Cache-Control", "no-cache, no-store, must-revalidate");

  let ip = req.params.ip;
  if (ip == 'self') {
    ip = req.ip.replace(/^.*:/,'');
  }
  let url = req.query.url || req.body.url;
  const name = req.query.name || req.body.name;
  if (name) {
    const server = _.findWhere(config.preset_server_list, { name });
    if (server) {
      url = server.url;
    }
  }
  if (!ip) {
    throw { code: 400, body: "ip is required" };
  }
  if (!url) {
    throw { code: 400, body: "url or a valid name is required" };
  }

  let body = false;
  let new_body = false;
  let server_config = false;
  async.series([
  (done) => {
    read_config((err,_config,_body) => {
      server_config = _config;
      body = _body;
      done(err);
    });
  },
  (done) => {
    new_body = body;
    if (ip in server_config.ip_proxy_map) {
      new_body = remove_proxy(ip,new_body);
    }
    new_body = add_proxy(ip,url,new_body,server_config.insert_index);
    write_config(new_body,done);
  }],
  (err) => {
    if (err == 'conflict') {
      res.sendStatus(409);
    } else if (err) {
      res.sendStatus(500);
    } else {
      res.sendStatus(200);
    }
  });
}

function clear_proxy(req,res) {
  res.header("Cache-Control", "no-cache, no-store, must-revalidate");

  let ip = req.params.ip;
  if (ip == 'self') {
    ip = req.ip.replace(/^.*:/,'');
  }
  if (!ip) {
    throw { code: 400, body: "ip is required" };
  }

  let body = false;
  let new_body = false;
  let config = false;
  async.series([
  (done) => {
    read_config((err,_config,_body) => {
      config = _config;
      body = _body;
      done(err);
    });
  },
  (done) => {
    new_body = body;
    if (ip in config.ip_proxy_map) {
      new_body = remove_proxy(ip,new_body);
    }
    write_config(new_body,done);
  }],
  (err) => {
    if (err == 'conflict') {
      res.sendStatus(409);
    } else if (err) {
      res.sendStatus(500);
    } else {
      res.sendStatus(200);
    }
  });
}

function read_config(done) {
  fs.readFile(config.nginx_config,(err,data) => {
    const ret = {
      default_proxy: false,
      insert_index: false,
      ip_proxy_map: {},
    };
    let body = false;
    if (err) {
      console.error("read_config: err:",err);
    } else {
      body = data.toString();
      const no_comments = body.replace(/#[^\n]*/g,'')
      const default_match = body.match(/\n\s*proxy_pass\s*([^\s;]*)\s*;[^\n]*\n/);
      if (default_match && default_match.length > 1) {
        ret.default_proxy = default_match[1];
        ret.insert_index = default_match.index + default_match[0].length;
      }
      const IP_REGEX = /if\s*\(\s*\$remote_addr\s*\~\*\s*([^\s]*)\s*\)\s*\{\s*proxy_pass\s*([^\s;]*)/g;
      const proxy_match = no_comments.replace(IP_REGEX,(match,ip,url) => {
        ret.ip_proxy_map[ip] = url;
      });
    }
    done(err,ret,body);
  });
}

function add_proxy(ip,url,body,insert_index) {
  const proxy =
"\nif ( $remote_addr ~* " + ip + " ) {\n"
+ " proxy_pass " + url + ";\n"
+ "}\n";

  const new_body = body.slice(0,insert_index)
    + proxy
    + body.slice(insert_index);
  return new_body;
}

function remove_proxy(ip,body) {
  const REMOVE_REGEX = /\n\s*if\s*\(\s*\$remote_addr\s*\~\*\s*([^\s]*)\s*\)\s*\{\s*proxy_pass\s*([^\s;]*)\s*;[^\}]*\}[^\n]*\n/g;
  const new_body = body.replace(REMOVE_REGEX,(full,found_ip) => {
    let ret = full;
    if (found_ip == ip) {
      ret = "\n";
    }
    return ret;
  });
  return new_body;
}

let is_writing = false;
function write_config(new_body,done) {
  if (!is_writing) {
    is_writing = true;

    let old_body = false;
    let need_rollback = false;
    async.series([
    (done) => {
      fs.readFile(config.nginx_config,(err,data) => {
        if (err) {
          console.error("write_config: read err:",err);
        }
        old_body = data;
        done(err);
      });
    },
    (done) => {
      fs.writeFile(config.nginx_config,new_body,(err,data) => {
        if (err) {
          console.error("write_config: read err:",err);
        }
        need_rollback = true;
        done(err);
      })
    },
    (done) => {
      if (config.verify_cmd) {
        exec(config.verify_cmd,(error_code,stdout,stderr) => {
          let err = null;
          if (error_code) {
            console.error("write_config: verify failed:",error_code,stdout,stderr);
            err = 'verify_failed';
          } else {
            need_rollback = false;
          }
          done(err);
        });
      } else {
        done(null);
      }
    },
    (done) => {
      if (config.reload_cmd) {
        exec(config.reload_cmd,(error_code,stdout,stderr) => {
          let err = null;
          if (error_code) {
            console.error("write_config: reload failed:",error_code,stdout,stderr);
            err = 'reload_failed';
          }
          done(err);
        });
      } else {
        done(null);
      }
    }],
    (err) => {
      if (err && need_rollback) {
        console.log("write_config: rollback file");
        fs.writeFile(config.nginx_config,old_body,() => {
          is_writing = false;
          done(err)
        });
      } else {
        is_writing = false;
        done(err);
      }
    });
  } else {
    done('conflict');
  }
}
