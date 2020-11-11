/**
 * Module dependencies
 */

const util = require('util');
const path = require('path');
const _ = require('@sailshq/lodash');
const mysql = require('mysql');
const fs = require('fs');
const crypto = require('crypto');

const connPromises = {};

/**
 * sails-generate-dbm
 *
 * Usage:
 * `sails generate dbm`
 *
 * @description Generates a dbm.
 * @docs https://sailsjs.com/docs/concepts/extending-sails/generators/custom-generators
 */

module.exports = {

  /**
   * `before()` is run before executing any of the `targets`
   * defined below.
   *
   * This is where we can validate user input, configure default
   * scope variables, get extra dependencies, and so on.
   *
   * @param  {Dictionary} scope
   * @param  {Function} done
   */
  before: function (scope, done) {
    const _done = (function () {
      Promise.all(Object.keys(connPromises).map(key => {
        return connPromises[key].then(conn => {
          conn.destroy();
        });
      })).then(() => {
        done.apply(this, arguments);
      });
    }).bind(this);
    scope.exit = function () {
      Promise.all(Object.keys(connPromises).map(key => {
        return connPromises[key].then(conn => {
          conn.destroy();
        });
      })).then(()=>{
        process.exit.apply(process, arguments);
      });
    };
    if (scope.help || scope.usage) {
      const database = (scope.database || '大写数据库名称').toUpperCase();
      return console.error(
        '使用: sails generate dbm 模块名称 --table 表\n\n' +
        '选项:\n\n' +
        ' -d, --database  数据库(使用`--connection`时可选)\n' +
        ' --table         表\n' +
        ' --host          数据库地址\n' +
        ' --port          数据库端口\n' +
        ' --username      登录用户名\n' +
        ' --password      登录密码(不推荐在命令行传入, 在提示密码时输入)\n' +
        ' --save          保存数据库信息(以便重复使用)\n' +
        ' --connection    使用配置文件中的connecions中指定的连接\n' +
        ' --hook          需要优先加载指定的hook\n' +
        ' --env           配合`--connecion`使用，加载指定的环境的连接，也可以通过`process.env.NODE_ENV`指定\n' +
        ' --templates     模块模板目录(使用默认模版)\n' +
        ' --verbose       打印详细日志\n\n' +
        ' --dependencies  依赖的模块' +
        '数据库地址、端口、用户名、密码也可以提前在环境变量中设置好。\n' +
        '如果是通用地址、账号密码，使用以下变量进行设置:\n' +
        ' `SAILS_DBM_HOST` 数据库地址\n' +
        ' `SAILS_DBM_PORT` 数据库地址\n' +
        ' `SAILS_DBM_USER` 数据库登录用户\n' +
        ' `SAILS_DBM_PWD`  数据库登录密码\n\n' +
        '如果每个数据库单独的账号密码，使用以下变量进行设置(以大写数据库名结尾):\n' +
        ' `SAILS_DBM_HOST_' + database + '` 数据库地址\n' +
        ' `SAILS_DBM_PORT_' + database + '` 数据库地址\n' +
        ' `SAILS_DBM_USER_' + database + '` 数据库登录用户\n' +
        ' `SAILS_DBM_PWD_' + database + '`  数据库登录密码\n'
      )
    }
    if (scope.from) {
      return this.fromFile(scope.from, scope, _done);
    } else if (scope.rebuild) {
      return this.rebuild(scope.rebuild, scope, _done);
    } else if (scope.config && !/.sailsrc/.test(scope.config)) {
      return this.fromConfig(scope.config, scope, _done);
    } else if (scope.rebuilds) {
      let dir = scope.rebuilds === true ? './' : scope.rebuilds;
      let files = dir.endsWith('/') ? fs.readdirSync(path.resolve(scope.rootPath, dir)) : [dir].concat(scope.args);
      let rootPath = scope.rootPath;
      scope.args = [];
      const buildNext = () => {
        if (files.length === 0) {
          return Promise.resolve(true);
        }
        const file = files.shift();
        return new Promise(resolve => {
          let _scope = _.cloneDeep(scope);
          const project = _scope.rootPath = path.resolve(rootPath, file);
          if (!fs.existsSync(path.resolve(_scope.rootPath, 'api/models'))) {
            return resolve(buildNext());
          }
          process.chdir(_scope.rootPath);
          _scope.exit = () => {
            console.error('project build done => %s\n', project);
            return resolve(buildNext());
          };
          console.error('start build project => ', project);
          try {
            return this.rebuild(true, _scope);
          } catch (err) {
            console.error('build project error =>', project, err);
            process.exit(1);
          }
        });
      };
      return buildNext().then(() => {
        scope.exit(0);
      });
    }
    return this.before0(scope, _done);
  },
  rebuild: function (dir, scope) {
    if (dir === true) {
      dir = 'api/models';
    }
    let files = fs.readdirSync(dir);
    let globals = {};
    return Promise.all(files.map(file => {
      if (/(\w+)\.js$/.test(file)) {
        globals[RegExp.$1] = true;
      } else {
        return;
      }
      return new Promise(resolve => {
        let _scope = _.cloneDeep(scope);
        _scope.exit = resolve;
        return this.fromFile(path.resolve(dir, file), _scope, resolve);
      });
    })).then(() => {
      if (scope.eslint) {
        let eslintrc = scope.eslint === true ? '.eslintrc.sails' : scope.eslint;
        fs.readFile(eslintrc, { encoding: 'utf-8' }, (err, data) => {
          if (err && eslintrc !== '.eslintrc.sails') {
            console.error('read eslintrc error =>', err);
            return scope.exit(1);
          }
          data = JSON.parse(data || '{}');
          data.globals = Object.assign(data.globals, globals);
          fs.writeFile(eslintrc, JSON.stringify(data, null, 2), err => {
            if (err) {
              console.error('geneate eslintrc error =>', err);
              return scope.exit(1);
            }
            scope.exit(0);
          });
        });
      } else {
        scope.exit(0);
      }
    });
  },
  fromFile: function (file, scope, done) {
    fs.readFile(file, 'utf8', (err, content) => {
      if (err) {
        return scope.exit(1);
      }
      let line = content.split('\n').filter(s => s.indexOf('`sails generate dbm') > 0)[0];
      if (/`sails generate dbm\s+(\S+)\s+(.*)`/.test(line)) {
        scope.args.push(RegExp.$1);
        let args = RegExp.$2.split(' ');
        for (let i = 0; i < args.length; i++) {
          let key = args[i];
          if (/^--no-(.*)$/.test(key)) {
            scope[RegExp.$1] = false;
          } else if (/^--(.*)$/.test(key)) {
            scope[RegExp.$1] = /^--/.test(args[i + 1]) || args[i + 1] === undefined ? true : args[i + 1];
            i++;
          }
        }
        return this.before0(scope, done);
      } else if (scope.exit) {
        scope.exit();
      } else {
        return process.exit(2);
      }
    });
  },
  fromConfig: function (file, scope, done) {
    if (!scope.table) {
      console.error('需要指定表名`sails generate dbm --config ' + file + ' --table 表名`');
      return process.exit(2);
    }
    fs.readFile(file, 'utf8', (err, content) => {
      if (err) {
        return scope.exit(1);
      }
      let line = content.split('\n').filter(s => s.indexOf('`sails generate dbm') > 0)[0];
      if (/`sails generate dbm\s+(\S+)\s+(.*)`/.test(line)) {
        let filename = RegExp.$1;
        let table = scope.table;
        let args = RegExp.$2.split(' ');
        for (let i = 0; i < args.length; i++) {
          let key = args[i];
          if (/^--no-(.*)$/.test(key)) {
            scope[RegExp.$1] = false;
          } else if (/^--(.*)$/.test(key)) {
            scope[RegExp.$1] = /^--/.test(args[i + 1]) || args[i + 1] === undefined ? true : args[i + 1];
            i++;
          }
        }
        let arr0 = filename.split(/([A-Z.][a-z0-9]*)/).filter(s => s).map(s => s.toLowerCase());
        let arr1 = scope.table.toLowerCase().split(/_/);
        for (let i = 0; i < arr0.length; i++) {
          let p = arr1.indexOf(arr0[i]);
          if (p > -1) {
            let matched = true;
            for (let j = p; j < arr1.length; j++) {
              if (arr1[j] !== arr0[j - p + i]) {
                matched = false;
                break;
              }
            }
            if (matched) {
              scope.args.push(arr2name(table.split(/_/).slice(p).concat(arr0.slice(arr1.length - p))));
              break;
            }
          }
        }
        if (!scope.args[0]) {
          scope.args.push(arr2name(table.split(/_/)));
        }
        scope.table = table;
        return this.before0(scope, done);
      } else if (scope.exit) {
        scope.exit();
      } else {
        return process.exit(2);
      }
    });
  },
  before0: function (scope, done) {
    if (!scope.args[0]) {
      console.error(
        '需要指定模块名`sails generate dbm 模块名 --table 表名`\n\n' +
        '或查看使用手册`sails generate dbm --usage`'
      )
      return process.exit(2);
    }
    scope._extra = '';
    if (scope.templates) {
      this.templatesDirectory = path.resolve(scope.rootPath, scope.templates);
      scope._extra = scope._extra + ' --templates ' + scope.templates
    }
    if (scope.dependencies) { // 有依赖，需要先加载依赖模块
      scope._extra = scope._extra + ' --dependencies ' + scope.dependencies
      scope.dependencies.split(',').map(dep => {
        dep = dep.trim();
        if (dep.startsWith('.')) {
          return require(path.resolve(process.cwd(), dep));
        } else if (dep) {
          try {
            return require(dep);
          } catch (err) {
            return require(path.resolve(process.cwd(), 'node_modules', dep));
          }
        }
      });
    }
    const self = this;
    if (scope.username && !scope.password) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.question('Database Password: ', function (password) {
        scope.password = password;
        rl.close();
        rl.output.write('\n');
        self._before(scope, done);
      });
      rl._writeToOutput = function _writeToOutput () { };
    } else if (scope.username) {
      self._before(scope, done);
    } else {
      const env = scope.env || process.env.NODE_ENV
      if (scope.hooks) {
        scope._extra += ' --hooks ' + scope.hooks;
      }
      return loadConfig(scope.rootPath, env, scope.hooks).then(config => {
        if (!scope.connection) {
          scope.connection = _.get(config, ['models', 'connection']);
          if (!scope.connection && _.get(config, ['datastores', 'default'])) {
            scope.connection = 'default';
          }
        } else {
          scope._extra += ' --connection ' + scope.connection;
        }
        const connection = _.get(config, ['connections', scope.connection]) ||
          _.get(config, ['datastores', scope.connection]);
        if (connection && (typeof connection === 'string' || Object.keys(connection).filter(k => k.toLowerCase() === 'zkpath'))) {
          if (!env) {
            console.error(
              '使用zookeeper获取连接必须指定环境参数`--env 环境`或指定环境变量`NODE_ENV=`'
            )
            return process.exit(2)
          }
          return loadZkConnection(connection, config, scope.zkHost, scope.connection, env);
        }
        return Promise.resolve([connection, ''])
      }).then(([connection, key]) => {
        if (connection) {
          if (scope.env || process.env.NODE_ENV) {
            scope._extra += ' --env ' + (scope.env || process.env.NODE_ENV);
          }
          if (!scope.host) {
            scope.host = connection.host;
            scope.port = connection.port;
          }
          if (!scope.username) {
            scope.username = connection.user || connection.username;
            scope.password = connection.password || connection.pwd;
          }
          if (!scope.database) {
            scope.database = connection.database;
          }
          if (!scope.database || !scope.username || !scope.host) {
            console.error(
              '数据库连接`--connection ' + scope.connection + '`指定的`' + key + '`不正确或未配置'
            )
            return process.exit(2);
          }
        } else {
          console.error(
            '`--connection`指定的连接`' + scope.connection + '`配置文件中不存在'
          )
          return process.exit(2);
        }
        return self._before(scope, done);
      }).catch(err => {
        console.error(err)
      });
    }
  },
  _before: function (scope, cb) {
    // Decide the output filename for use in targets below:
    scope.filename = scope.args[0];
    if (!/\.[^\.]+$/.test(scope.filename)) {
      scope.filename = scope.filename + '.js';
    }
    if (!scope.table) {
      console.error(
        '需要指定model对应的表`--table 表名`'
      )
      return process.exit(2);
    }
    if (!scope.connection && (scope.database || scope.d)) {
      scope._extra += ' --database ' + scope.database;
    }
    scope.database = scope.database || scope.d || process.env.SAILS_DBM_DB || process.env.SAILS_DBM_DATABASE;
    if (!scope.database && !scope.connection) {
      console.error(
        '必须指定数据库名`--database 数据库名`或数据库连接`--connection 连接`'
      )
      return process.exit(2);
    }
    const DB = scope.database && ('_' + scope.database.toUpperCase()) || ''
    const DB_HOST = 'SAILS_DBM_HOST' + DB;
    const DB_PORT = 'SAILS_DBM_PORT' + DB;
    const DB_USER = 'SAILS_DBM_USER' + DB;
    const DB_PWD = 'SAILS_DBM_PWD' + DB;
    const waHost = scope.host || process.env[DB_HOST] || process.env.SAILS_DBM_HOST;
    const waPort = parseInt(scope.port || process.env[DB_PORT] || process.env.SAILS_DBM_PORT, 10) || 3306;
    const waUser = scope.username || aesDecrypt(process.env[DB_USER], DB) || aesDecrypt(process.env.SAILS_DBM_USER, waHost);
    const secUser = aesEncrypt(waUser, DB);
    const SECRET = secUser + '@' + waHost;
    const DB_SECRET = secUser + '@' + waHost + '/' + DB;
    const envPwd = aesDecrypt(process.env[DB_PWD] || process.env['SAILS_DBM_PASSWORD' + DB], DB_SECRET) ||
      aesDecrypt(process.env.SAILS_DBM_PWD || process.env.SAILS_DBM_PASSWORD, SECRET);
    if (scope.password && envPwd === undefined && scope.save !== undefined) {
      scope.save = true;
    }
    const waPwd = scope.password || envPwd;
    if (waHost === undefined || waUser === undefined || waPwd === undefined) {
      if (scope.verbose) {
        console.error('缺少参数: host=%s, user=%s, pwd=%s', waHost, waUser, waPwd)
      }
      console.error(
        '首次使用，请使用参数`--host ip --port port --username username --save`\n\n' +
        '或使用连接参数`--connection connection --env environment`\n\n' +
        '或输入`--usage`参数查看帮助'
      )
      return process.exit(2);
    }
    if (scope.autoCreatedAt === true) {
      scope._extra += ' --autoCreatedAt';
    } else if (scope.autoCreatedAt === false) {
      scope._extra += ' --no-autoCreatedAt';
    }
    if (scope.autoUpdatedAt === true) {
      scope._extra += ' --autoUpdatedAt';
    } else if (scope.autoUpdatedAt === false) {
      scope._extra += ' --no-autoUpdatedAt';
    }
    const sql = `SELECT a.*, b.TABLE_COMMENT 
      FROM information_schema.COLUMNS AS a, information_schema.TABLES AS b
      WHERE a.TABLE_SCHEMA = '${scope.database}'
      AND a.TABLE_NAME = '${scope.table}'
      AND a.TABLE_NAME = b.TABLE_NAME
      AND a.TABLE_SCHEMA = b.TABLE_SCHEMA`;
    const version = parseInt(_.get(scope, 'sailsPackageJSON.version', 0));
    const vInt = version > 0 ? 'number' : 'integer';
    const vFloat = version > 0 ? 'number' : 'float';
    const key = `${waUser}:${waPwd}@${waHost}:${waPort}/${scope.database}`;
    let connPromise = connPromises[key];
    if (!connPromise) {
      connPromise = connPromises[key] = new Promise((resolve, reject) => {
        let conn = mysql.createConnection({
          host: waHost,
          port: waPort,
          user: waUser,
          password: waPwd,
          database: scope.database,
        });
        conn.connect(function (err) {
          if (err) {
            console.error('connect error =>', sql, conn, err);
            reject(err);
            return process.exit(2);
          }
          resolve(conn);
        });
      });
    }
    connPromise.then(conn => {
      if (scope.verbose) {
        console.error('sql =>', sql);
      }
      conn.query(sql, function (err, columns) {
        if (err) {
          console.error('query error =>', sql, err);
          return process.exit(2);
        }
        const ret = {
          tableName: scope.table,
          attributes: {}
        };
        let tableComment = '';
        for (let column of columns) {
          const columnName = column['COLUMN_NAME'];
          tableComment = column['TABLE_COMMENT'];
          const key = _.camelCase(columnName);
          const o = ret.attributes[key] = {};
          if (column['COLUMN_COMMENT']) {
            o.comment = column['COLUMN_COMMENT'];
          }
          if (key !== columnName) o.columnName = columnName;
          const type = getType(column['COLUMN_TYPE'], version);
          if (Array.isArray(type)) {
            o.type = type[0] && type[0].toLowerCase()
            o.enum = type[1]
          } else {
            o.type = type.toLowerCase()
          }
          if (version > 0) {
            o.columnType = column['COLUMN_TYPE'];
          }
          if (column['COLUMN_DEFAULT']) o.defaultsTo = column['COLUMN_DEFAULT'];
          if (o.type === 'boolean' && o.defaultsTo) {
            let m
            if ((m = o.defaultsTo.match(/b?['"]?([01])['"]?/))) {
              o.defaultsTo = m[1] === '1';
            }
          }
          if ((o.type === vInt || o.type === vFloat) && typeof o.defaultsTo !== 'undefined') {
            o.defaultsTo = Number(o.defaultsTo);
          }
          if (o.type === 'datetime' &&
            (key === 'createdAt' || key === 'updatedAt') &&
            o.defaultsTo === 'CURRENT_TIMESTAMP') {
            delete o.defaultsTo;
          } else if (o.type === vInt &&
            (key === 'createdAt' || key === 'updatedAt') &&
            o.defaultsTo === 0) {
            if (column['DATA_TYPE'] === 'int') {
              if (scope.autoCreatedAt !== false) {
                ret.beforeCreate = beforeCreate;
              }
              if (scope.autoUpdatedAt !== false) {
                ret.beforeUpdate = beforeUpdate;
              }
            } else {
              if (version > 0) {
                if (scope.autoCreatedAt !== false && key === 'createdAt') {
                  o.autoCreatedAt = true;
                }
                if (scope.autoUpdatedAt !== false && key === 'updatedAt') {
                  o.autoUpdatedAt = true;
                }
              }
              delete o.defaultsTo;
            }
          }
          if (column['EXTRA'] && column['EXTRA'].includes('auto_increment')) {
            o.autoIncrement = true
          }
          if (column['COLUMN_KEY'] === 'PRI') {
            if (version > 0) {
              if (!o.autoIncrement) {
                o.required = true;
              }
              o.unique = true;
              ret.primaryKey = (ret.primaryKey ? ret.primaryKey + ',' + key : key);
            } else {
              o.primaryKey = true;
            }
          }
          if (version > 0 && column['IS_NULLABLE'] === 'YES' && type !== 'ref') {
            o.allowNull = true;
          }
        }
        if (version > 0) {
          if (!ret.attributes.createdAt) {
            ret.attributes.createdAt = false;
          }
          if (!ret.attributes.updatedAt) {
            ret.attributes.updatedAt = false;
          }
        }
        if (ret.primaryKey && ret.primaryKey.split(',').length > 1) {
          delete ret.primaryKey;
        }
        const genFile = path.resolve(scope.rootPath, 'api/generates', scope.filename);
        let data = [
          '/* eslint semi: off */',
          tableComment && `/**\n * ${tableComment}\n */`,
          `module.exports = ${inspect(ret)};`,
          ''
        ].join('\n');
        console.log('update generated model(%s) => %s', version, genFile);
        let genData = data.replace(/({)\n\s*comment:\s*'(.*)',?/img, '$1 // $2');
        fs.writeFile(genFile, genData, err => {
          if (err) {
            if (err.code !== 'ENOENT') {
              console.error('generate file error');
              return process.exit(1);
            }
            let dir = path.dirname(genFile);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(genFile, genData);
          }
          if (scope.save) {
            if (process.platform === 'win32') {
              console.log(
                '请在控制台中执行以下命令:\n`\n' +
                `SETX ${DB_HOST}=${waHost}\n` +
                `SETX ${DB_PORT}=${waPort}\n` +
                `SETX ${DB_USER}=${aesEncrypt(waUser, DB)}\n` +
                `SETX ${DB_PWD}=${aesEncrypt(waPwd, DB_SECRET)}\n` +
                '`\n或使用以下通用设置:\n`\n' +
                `SETX SAILS_DBM_HOST=${waHost}\n` +
                `SETX SAILS_DBM_PORT=${waPort}\n` +
                `SETX SAILS_DBM_USER=${aesEncrypt(waUser, waHost)}\n` +
                `SETX SAILS_DBM_PWD=${aesEncrypt(waPwd, SECRET)}\n` +
                '`\n'
              )
            } else {
              console.log(
                '请将以下内容保存到用户环境变量:\n`\n' +
                `export ${DB_HOST}=${waHost}\n` +
                `export ${DB_PORT}=${waPort}\n` +
                `export ${DB_USER}=${aesEncrypt(waUser, DB)}\n` +
                `export ${DB_PWD}=${aesEncrypt(waPwd, DB_SECRET)}\n` +
                '`\n或使用以下通用设置:\n`\n' +
                `export SAILS_DBM_HOST=${waHost}\n` +
                `export SAILS_DBM_PORT=${waPort}\n` +
                `export SAILS_DBM_USER=${aesEncrypt(waUser, waHost)}\n` +
                `export SAILS_DBM_PWD=${aesEncrypt(waPwd, SECRET)}\n` +
                '`\n'
              )
            }
          }
          const modelFile = path.resolve(scope.rootPath, 'api/models/' + scope.filename);
          fs.readFile(modelFile, { encoding: 'utf8' }, (err, data) => {
            if (err) {
              scope.id = modelFile;
              scope.generatorType = scope.generatorType + '-model';
              if (scope.eslint !== false && fs.existsSync('.eslintrc')) {
                let eslintrc = typeof scope.eslint === 'string' ? scope.eslint : '.eslintrc.sails';
                let eslintSails;
                try {
                  eslintSails = JSON.parse(fs.readFileSync(eslintrc, { encoding: 'utf-8' }));
                } catch (err) {
                  if (eslintrc === '.eslintrc.sails') {
                    eslintSails = {};
                  } else {
                    console.error('read eslintrc error =>', err);
                  }
                }
                if (!eslintSails.globals) {
                  eslintSails.globals = {};
                  let files = fs.readdirSync(path.resolve(scope.rootPath, 'api/models/'));
                  for (let file of files) {
                    if (/(\w+)\.js$/.test(file)) {
                      eslintSails.globals[RegExp.$1] = true;
                    }
                  }
                  console.log('please extend eslintrc by generated file =>', eslintrc);
                }
                eslintSails.globals[scope.filename.replace(/\.js$/, '')] = true;
                fs.writeFileSync(eslintrc, JSON.stringify(eslintSails, null, 2));
              }
              cb();
            } else {
              let line = data.split('\n').filter(s => s.indexOf('`sails generate dbm ') > 0)[0];
              if (/`sails generate dbm (.*)`/.test(line)) {
                let cmd = RegExp.$1;
                const old = `${scope.filename} --table ${scope.table}${scope._extra}`;
                if (sortCmd(cmd) !== sortCmd(old)) {
                  console.error('\n生成model的命令与原命令不一致，请确认是否需要更新model的命令，如需更新可以删除model重新执行命令\n');
                  console.error('当前命令: ' + cmd);
                  console.error('原命令: ' + old);
                  scope.exit(2);
                } else {
                  scope.exit(0);
                }
              }
            }
          });
        });
      });
    });
  },

  /**
   * The files/folders to generate.
   * @type {Dictionary}
   */
  targets: {
    './api/models/:filename': {
      template: 'model.template.js'
    },
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // • e.g. create a folder:
    // ```
    // './hey_look_a_folder': { folder: {} }
    // ```
    //
    // • e.g. create a dynamically-named file relative to `scope.rootPath`
    // (defined by the `filename` scope variable).
    //
    // The `template` helper reads the specified template, making the
    // entire scope available to it (uses underscore/JST/ejs syntax).
    // Then the file is copied into the specified destination (on the left).
    // ```
    // './:filename': { template: 'example.template.js' },
    // ```
    //
    // • See https://sailsjs.com/docs/concepts/extending-sails/generators for more documentation.
    // (Or visit https://sailsjs.com/support and talk to a maintainer of a core or community generator.)
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  },


  /**
   * The absolute path to the `templates` for this generator
   * (for use with the `template` and `copy` builtins)
   *
   * @type {String}
   */
  templatesDirectory: templatesDirectory()
};

function sortCmd (cmd) {
  return cmd.split(' ').filter(s => s).sort().join(' ');
}

function templatesDirectory () {
  let cwdModel = path.resolve(process.cwd(), './templates', 'model.template.js');
  if (fs.existsSync(cwdModel)) {
    return path.resolve(process.cwd(), './templates');
  }
  return path.resolve(__dirname, './templates');
}

const iv = Buffer.alloc(16, 0);

function aesEncrypt (data, key) {
  const c = crypto.createCipher('aes192', key);
  let s = c.update(data && data.toString() || '', 'utf8', 'hex');
  return (s + c.final('hex')).toUpperCase();
}

function aesDecrypt (data, key) {
  if (!data) return data
  try {
    const d = crypto.createDecipheriv('aes192', key, iv);
    let s = d.update(data.toString(), 'hex', 'utf8');
    return s + d.final('utf8');
  } catch (err) {
    return data.toString();
  }
}

const configCache = {};

function loadConfig (rootPath, env, hooks) {
  const OLD_ENV = process.env.NODE_ENV
  if (env) {
    process.env.NODE_ENV = env
  }
  const cacheKey = rootPath + ':' + env + ':' + hooks;
  if (configCache[cacheKey]) {
    return configCache[cacheKey];
  }
  configCache[cacheKey] = new Promise((resolve, reject) => {
    const confPath = path.resolve(rootPath, 'config');
    fs.readdir(confPath, (err, files) => {
      if (err) return reject(err)
      resolve(_.merge.apply(_, files.filter(file => {
        return /(connections|zkConfig|models|datastores|custom)\.js/i.test(file)
      }).concat([path.resolve(confPath, 'env', env)]).map(file => {
        return tryRequire(path.resolve(confPath, file))
      })))
    })
  }).then(config => {
    if (hooks && hooks.length > 0) { // 有依赖
      const sails = {
        log: console.log.bind(console),
        config,
      };
      _.defaults(config, {
        appPath: process.cwd(),
        policies: {},
      });
      config.log = false;
      global.sails = sails;
      sails.log.warn = console.log.bind(console);
      sails.log.debug = console.log.bind(console);
      hooks.split(',').map(name => {
        let hook = require(path.resolve(process.cwd(), 'node_modules', 'sails-hook-' + name))(sails);
        if (hook && hook.configure) {
          if (typeof hook.defaults === 'function') {
            hook.defaults = hook.defaults();
          }
          _.defaultsDeep(sails.config, hook.defaults)
          hook.configure();
        }
      });
      config = sails.config;
    }
    process.env.NODE_ENV = OLD_ENV;
    return config
  });
  return configCache[cacheKey];
}

function tryRequire (mod, cwd) {
  try {
    return require(mod)
  } catch (err) {
    if (cwd) {
      if (cwd === true) {
        cwd = process.cwd();
      }
      return tryRequire(path.resolve(cwd, 'node_modules', mod));
    }
    return null;
  }
}

function hostsToString (hosts) {
  return _.isArray(hosts) ? hosts.join(',') : hosts;
}

function keysToArray (keys) {
  if (_.isString(keys)) {
    keys = keys.split(',');
  } else if (!_.isArray(keys)) {
    keys = [keys];
  }
  keys = _.reduce(keys, function (r, key) {
    if (_.isString(key)) {
      r.push(key);
    } else if (_.isPlainObject(key)) {
      _.map(key, function (v, k) {
        r.push(k);
        if (sails.config[k] === undefined) {
          sails.config[k] = v;
        }
      });
    }
    return r;
  }, []);
  return keys;
}

const zkLoaderCache = {};
function loadZkConnection (connection, config, zkHost, name, env) {
  zkHost = zkHost || hostsToString(config.zkHost || _.get(config, 'zkConfig.zkHost'));
  let zkBase = config.zkBase || _.get(config, 'zkConfig.zkBase');
  let zkKeys = keysToArray(config.zkKeys || _.get(config, 'zkConfig.zkKeys'));
  let zkObjKey = config.zkObjKey || _.get(config, 'zkConfig.zkObjKey') || 'zkpath';
  zkKeys = zkKeys.map(k => k.toLowerCase());
  zkKeys.indexOf(zkObjKey) < 0 && zkKeys.push(zkObjKey);
  const key = typeof connection === 'string' ? connection : connection[Object.keys(connection).filter(key => zkKeys.indexOf(key.toLowerCase()) > -1)[0]];
  if (!key) {
    return Promise.resolve([connection, key]);
  }
  const loader = tryRequire('sails-hook-zkconfig/lib/load', process.cwd());
  if (loader) {
    const tmp = {
      connections: {
        [name]: connection
      }
    }
    const cacheKey = zkHost + ':' + name + ':' + key;
    if (zkLoaderCache[cacheKey]) {
      return zkLoaderCache[cacheKey];
    }
    zkLoaderCache[cacheKey] = new Promise(resolve => {
      console.log('load config from environment `' + env + '` by zkconfig...');
      loader(tmp, zkHost, zkKeys, zkObjKey, 30000, {}, null, null, zkBase);
      return resolve([tmp.connections[name], key]);
    });
    return zkLoaderCache[cacheKey];
  } else {
    const zookeeper = tryRequire('node-zookeeper-client', process.cwd());
    if (!zookeeper) {
      return Promise.reject('非`zookeeper`配置项目或模块未安装')
    }
    const key = typeof connection === 'string' ? connection : connection[Object.keys(connection).filter(k => k.toLowerCase() === 'zkpath')[0]];
    const cacheKey = zkHost + ':' + name + ':' + key;
    if (zkLoaderCache[cacheKey]) {
      return zkLoaderCache[cacheKey];
    }
    zkLoaderCache[cacheKey] = new Promise((resolve, reject) => {
      const base = typeof connection === 'string' ? {} : connection;
      console.log('load config from environment `' + env + '` by zkclient =>', zkHost, key);
      let client = zookeeper.createClient(zkHost);
      client.on('connected', () => {
        client.getData(key, (err, data) => {
          if (err) return reject(err);
          let v = data.toString('utf-8');
          try {
            client.close();
            return resolve([_.merge(base, JSON.parse(v)), key]);
          } catch (e) {
            client.close();
            return resolve([_.merge(base, v), key]);
          }
        })
      });
      client.connect();
    });
    return zkLoaderCache[cacheKey];
  }
}

const getType = (t, v) => {
  t = t.toLowerCase()

  // boolean
  if (t === 'tinyint(1)' || t === 'boolean' || t === 'bit(1)') return 'boolean'

  // integer
  if (t.match(/^(smallint|mediumint|tinyint|bigint|int)/)) {
    if (v > 0) return 'number';
    return 'integer';
  }

  // float
  if (t.match(/^float|decimal/)) {
    if (v > 0) return 'number';
    return 'float';
  }

  // string
  if (t.match(/^string|varchar|varying|nvarchar|char/)) return 'string'

  // text
  if (t.match(/^longtext/)) {
    if (v > 0) return 'string';
    return 'longtext';
  }
  if (t.match(/^mediumtext/)) {
    if (v > 0) return 'string';
    return 'mediumtext';
  }
  if (t.match(/text$/)) {
    if (v > 0) return 'string';
    return 'text'
  }
  // date & time
  if (t === 'datetime') {
    if (v > 0) return 'ref'
    return 'datetime'
  }
  if (t.match(/^date/)) return 'date'
  if (t.match(/^time/)) return '<unsupported type>'

  // json
  if (t.match(/^json/)) return 'json'

  // enum
  if (t.match(/^enum/)) {
    let availables = t.match(/^enum\(((?:[\s\S]+?)(,?[\s\S]+?)*?)\)/)
    availables = availables[1]
    availables = availables.split(/,/).map(_.trim).filter(Boolean)
    availables = availables.map(s => _.trim(s, '\'"'))

    return ['string', availables]
  }

  return '<uknown type>'
}

function inspect (obj, space) {
  space = space || '';
  let rs = ['{'];
  for (let key in obj) {
    let v = obj[key];
    if (typeof v === 'object') {
      rs.push(`  ${space}${key}: ${inspect(obj[key], space + '  ')},`);
    } else if (typeof v === 'function') {
      let vs = v.toString().replace(/function \w+\s*\(/, 'function (')
        .replace(/\n/img, '\n' + space + '  ');
      rs.push(`  ${space}${key}: ${vs},`);
    } else {
      rs.push(`  ${space}${key}: ${util.inspect(v)},`);
    }
  }
  return rs.join('\n').replace(/,$/, '') + '\n' + space + '}';
}

function beforeCreate (recordToCreate, proceed) {
  if (!recordToCreate.createdAt) {
    recordToCreate.createdAt = recordToCreate.updatedAt = parseInt(Date.now() / 1000);
  }
  proceed();
};

function beforeUpdate (recordToCreate, proceed) {
  if (!recordToCreate.updatedAt) {
    recordToCreate.updatedAt = parseInt(Date.now() / 1000);
  }
  proceed();
};

function arr2name (arr) {
  return arr.map(a => {
    return a[0].toUpperCase() + a.slice(1).toLowerCase();
  }).join('')
}
