// node modules dependencies
import Express from 'express';
import React from 'react';
import ReactDOM from 'react-dom/server';
import favicon from 'serve-favicon';
import compression from 'compression';
import httpProxy from 'http-proxy';
import path from 'path';
import PrettyError from 'pretty-error';
import http from 'http';
import SocketIo from 'socket.io';
import {ReduxRouter} from 'redux-router';
import createHistory from 'history/lib/createMemoryHistory';
import {reduxReactRouter, match} from 'redux-router/server';
import {Provider} from 'react-redux';
import qs from 'query-string';
import WebpackIsomorphicTools from 'webpack-isomorphic-tools';

// dependencies of serverside render
import ApiClient from './helpers/ApiClient';
import createStore from './redux/create';
import Html from './helpers/Html';
import getStatusFromRoutes from './helpers/getStatusFromRoutes';

/**
 * Define isomorphic constants.
 */
global.__CLIENT__ = false;
global.__SERVER__ = true;
global.__DISABLE_SSR__ = false;  // <----- DISABLES SERVER SIDE RENDERING FOR ERROR DEBUGGING
global.__DEVELOPMENT__ = process.env.NODE_ENV !== 'production';

if (__DEVELOPMENT__) {
  if (!require('piping')({
      hook: true,
      ignore: /(\/\.|~$|\.json|\.scss$)/i
    })) {
    return;
  }
}

const app = new Express();
app.use(compression());

let hasSetup = false;
let isomorphicTools;
let config = require('./config');
let toolsConfig = require('../config/webpack-isomorphic-tools-config');

function setupProxy() {
  const proxy = httpProxy.createProxyServer({
    target: 'http://' + config.apiHost + ':' + config.apiPort,
    ws: true
  });

  // Proxy to API server
  app.use('/api', (req, res) => {
    proxy.web(req, res);
  });

  // added the error handling to avoid https://github.com/nodejitsu/node-http-proxy/issues/527
  proxy.on('error', (error, req, res) => {
    let json;
    if (error.code !== 'ECONNRESET') {
      console.error('proxy error', error);
    }
    if (!res.headersSent) {
      res.writeHead(500, {'content-type': 'application/json'});
    }

    json = {error: 'proxy_error', reason: error.message};
    res.end(JSON.stringify(json));
  });
}

function setupTools(rootDir) {
  toolsConfig.webpack_assets_file_path = rootDir + '/webpack-assets.json';

  isomorphicTools = new WebpackIsomorphicTools(toolsConfig);
  isomorphicTools
    .development(__DEVELOPMENT__)
    .server(rootDir);
}

function setupAssets(rootDir) {
  app.use(favicon(path.join(rootDir, 'static', 'favicon.ico')));
  app.use(Express.static(path.resolve(rootDir, 'static')));
}

function setupRenderer() {
  app.use((req, res) => {

    const getRoutes = require(path.resolve(config.webpack.resolve.alias.routes));
    const reducers = require(path.resolve(config.webpack.resolve.alias.reducers));

    let CustomHtml;
    if (config.webpack.resolve.alias.html) {
      CustomHtml = require(path.resolve(config.webpack.resolve.alias.html));
    } else {
      CustomHtml = Html;
    }

    if (__DEVELOPMENT__) {
      // Do not cache webpack stats: the script file would change since
      // hot module replacement is enabled in the development env
      isomorphicTools.refresh();
    }
    const pretty = new PrettyError();

    const client = new ApiClient(req);
    const store = createStore(reduxReactRouter, getRoutes, createHistory, client, reducers);

    function hydrateOnClient() {
      res.send('<!doctype html>\n' + ReactDOM.renderToString(<CustomHtml assets={isomorphicTools.assets()} store={store}/>));
    }

    if (__DISABLE_SSR__) {
      hydrateOnClient();
      return;
    }

    store.dispatch(match(req.originalUrl, (error, redirectLocation, routerState) => {
      if (redirectLocation) {
        res.redirect(redirectLocation.pathname + redirectLocation.search);
      } else if (error) {
        console.error('ROUTER ERROR:', pretty.render(error));
        res.status(500);
        hydrateOnClient();
      } else if (!routerState) {
        res.status(500);
        hydrateOnClient();
      } else {
        // Workaround redux-router query string issue:
        // https://github.com/rackt/redux-router/issues/106
        if (routerState.location.search && !routerState.location.query) {
          routerState.location.query = qs.parse(routerState.location.search);
        }

        store.getState().router.then(() => {
          const component = (
            <Provider store={store} key="provider">
              <ReduxRouter/>
            </Provider>
          );

          const status = getStatusFromRoutes(routerState.routes);
          if (status) {
            res.status(status);
          }
          res.send('<!doctype html>\n' + ReactDOM.renderToString(<CustomHtml assets={isomorphicTools.assets()} component={component} store={store} headers={res._headers} />));
        }).catch((err) => {
          console.error('DATA FETCHING ERROR:', pretty.render(err));
          res.status(500);
          hydrateOnClient();
        });
      }
    }));
  });
}

function validateConfig() {
  if (!config) {
    console.error('==>     ERROR: No configuration supplied.');
  }
  if (!toolsConfig) {
    console.error('==>     ERROR: Invalid tools configuration supplied.');
  }
  if (!config.port) {
    console.error('==>     ERROR: No PORT variable has been configured');
  }
  if (!config.host) {
    console.error('==>     ERROR: No HOST variable has been configured');
  }
  if (!config.webpack) {
    console.error('==>     ERROR: No webpack configuration supplied. See example at https://github.com/bdefore/redux-universal-starter#usage');
  } else {
    const resolve = config.webpack.resolve;
    if (!resolve || !resolve.root) {
      console.error('==>     ERROR: Webpack configuration must supply a root that maps to your project. See example at https://github.com/bdefore/redux-universal-starter#usage');
    }
    if (!resolve || !resolve.alias || !resolve.alias.routes || !resolve.alias.config || !resolve.alias.reducers) {
      console.error('==>     ERROR: Webpack configuration must supply aliases for routes, config, and reducers. See example at https://github.com/bdefore/redux-universal-starter#usage');
    }
  }
  // TODO: check for more
  console.log('Redux universal starter configuration is valid.');
}

export default class Starter {

  static configure(userConfig, userToolsConfig) {
    config = userConfig;
    config.apiPrefix = userConfig.apiPrefix || 'api';

    if (userToolsConfig) {
      toolsConfig = userToolsConfig;
    }
    validateConfig();
  }

  static app() {
    return app;
  }

  static setup(userConfig, userToolsConfig) {
    if(userConfig) {
      Starter.configure(userConfig, userToolsConfig);
    }

    let rootDir;
    if(config.webpack.context) {
      rootDir = path.resolve(config.webpack.context);
    } else {
      rootDir = path.resolve(__dirname, '..');
    }

    setupProxy();
    setupTools(rootDir);
    setupAssets(rootDir);
    setupRenderer();

    hasSetup = true;
  }

  static start() {
    if (!hasSetup) {
      Starter.app();
    }

    const server = new http.Server(app);

    if (config.isProduction && config.socket) {
      const io = new SocketIo(server);
      io.path('/api' + config.socket.path);
    }

    server.listen(config.port, (err) => {
      if (err) {
        console.error(err);
      }
      console.info('----\n==> ✅  %s is running, talking to API server on %s.', config.app.title, config.apiPort);
      console.info('==> 💻  Open http://%s:%s in a browser to view the app.', config.host, config.port);
    });
  }
}
