var Future = Npm.require('fibers/future');

/**
 * @summary Namespace for GMail-related items
 * @locus Server
 * @namespace
 */
GMail = {};

var CLIENT_STATE = {
  READY: 0,
  REFRESHING_TOKEN: 1
};

/**
 * @summary a Class for providing access to the given account
 * @param {Object} credentials - Credentials for accessing and resuming the access
 * to the given account API
 * @param {String} credentials.clientId - your Google App's ID
 * @param {String} credentials.clientSecret - your Google App's secret
 * @param {String} credentials.accessToken - token you got by authorizing user
 * @param {Date|Number} credentials.expirationDate - when accessToken will expire
 * @param {String} credentials.refreshToken - to get the new accessToken later
 * @class
 */
GMail.Client = function (credentials) {
  credentials.expirationDate = +credentials.expirationDate;
  this.credentials = credentials;
  this.poller = null;
  this.listeners = [];

  this.state = CLIENT_STATE.READY;
  this._tokenFutures = [];
};

/**
 * @summary registers a callback for every new email matching query
 * @param {String} query - a query using GMail query syntax:
 * https://support.google.com/mail/answer/7190?hl=en. Trashed and Spam emails
 * are ignored by default.
 * @param {String} [startHistoryId] - the historyId of the last message in
 * chronological order that will be ignored. If supplied startHistoryId
 * corresponds to message M, the callback will be fired for all consecutive
 * messages not including M.
 * @param {Function} cb - callback.
 */
GMail.Client.prototype.onNewEmail = function (query, startHistoryId, cb) {
  var self = this;
  self.onNewEmailRaw(query, startHistoryId, function (message) {
    cb(new GMail.Message(message));
  });
};

/**
 * @summary same as onNewEmail but the callback is called with the raw object
 * instead of a parsed instance of `GMail.Message`.
 */
GMail.Client.prototype.onNewEmailRaw = function (query, startHistoryId, cb) {
  var self = this;
  // 'starthistoryid' is optional
  if (typeof startHistoryId === 'function') {
    cb = startHistoryId;
    startHistoryId = null;
  }

  self.listeners.push(new GMail.Listener(self, query, startHistoryId, cb));

  if (! self.poller) {
    startHistoryId = self.listeners[0].startHistoryId;
    self.poller = new GMail.Poller(
      self, startHistoryId, _.bind(self.handleNewMessage, self));
  }
};

GMail.Client.prototype.handleNewMessage = function (message, historyId) {
  var self = this;
  // retrieve the full message, XXX should be done lazily
  var doc = self.get(message.id);
  _.each(self.listeners, function (listener) {
    listener.handleNewMessage(doc, historyId);
  });
};

// ensures that the access token in hands is valid and refreshes it if not
GMail.Client.prototype._ensureToken = function () {
  var self = this;

  // wait for the token to become valid
  if (self.state === CLIENT_STATE.REFRESHING_TOKEN) {
    var f = new Future;
    self._tokenFutures.push(f);
    f.wait();
  }

  // if token will expire in next 10 seconds, go refresh it
  if (self.credentials.expirationDate < +(new Date) + 10 * 1000) {
    self.state = CLIENT_STATE.REFRESHING_TOKEN;

    try {
      var r = HTTP.post("https://accounts.google.com/o/oauth2/token", {
        params: {
          'client_id': self.credentials.clientId,
          'client_secret': self.credentials.clientSecret,
          'refresh_token': self.credentials.refreshToken,
          'grant_type': 'refresh_token'
        }
      });

      // update the access token value and the expiration date
      self.credentials.accessToken = r.data.access_token;
      self.credentials.expirationDate =
        new Date((new Date) + r.data.expires_in * 1000);
    } catch (err) {
      // got an error :(
      // throw this error further everywhere!
      _.each(self._tokenFutures, function (f) {
        f.throw(err);
      });

      throw err;
    }

    self.state = CLIENT_STATE.READY;
    // resume suspended API requests
    _.each(self._tokenFutures, function (f) {
      Meteor.defer(function () { f.return(); });
    });

    // clear the queue
    self._tokenFutures.splice(0, self._tokenFutures.length);
  }
};

// Wrapping the web API of GMail

// Fetches a message
GMail.Client.prototype.get = Meteor.wrapAsync(function (id, cb) {
  var self = this;
  self._ensureToken();
  var urlBase = "https://www.googleapis.com/gmail/v1/users/me/messages/";

  increaseFacts();
  HTTP.get(urlBase + id, { params: {
    'access_token': self.credentials.accessToken
  } }, function (err, res) {
    cb(err, res && res.data);
  });
});

// Fetches an attachment from a message
GMail.Client.prototype.getAttachement = Meteor.wrapAsync(function (messageId, id, cb) {
  var self = this;
  self._ensureToken();
  var urlBase = `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/`;

  increaseFacts();
  HTTP.get(urlBase + id, { params: {
    'access_token': self.credentials.accessToken
  } }, function (err, res) {
    res.data.data = decodeBase64(res.data.data);
    cb(err, res && res.data);
  });
});

// Fetches a list of messages matching query, implements the logic of paging and
// fetching each individual message
GMail.Client.prototype.list = Meteor.wrapAsync(function (query, params, cb) {
  if (typeof params === 'function') {
    cb = params;
    params = null;
  }

  var self = this;
  self._ensureToken();

  var urlBase = "https://www.googleapis.com/gmail/v1/users/me/messages";

  var transform = function (page, length) {
    var messages = length === -1 ?
      page.messages : page.messages.slice(0, length);

    // run fetches for all messages in parallel
    var futures = _.map(messages, function (message) {
      var f = new Future;
      self.get(message.id, f.resolver());
      return f;
    });

    // await for all of them
    Future.wait(futures);
    return _.invoke(futures, 'get');
  };

  self._accum(urlBase, transform, _.extend({ q: query }, params), cb);
});

GMail.Client.prototype.history = Meteor.wrapAsync(function (id, cb) {
  var self = this;
  self._ensureToken();

  var urlBase = "https://www.googleapis.com/gmail/v1/users/me/history";

  var transform = function (page, length) {
    if (length === -1)
      return page.history;
    return page.history.slice(0, length);
  };

  self._accum(urlBase, transform, { startHistoryId: id }, cb);
});

// accumulates a paged list from given Google API url (list, history.list, etc)
// transform is called after each page is fetched
GMail.Client.prototype._accum =
  Meteor.wrapAsync(function (url, transform, extraParams, cb) {
  var self = this;
  // start w/o page token, i.e. first page
  var pageToken = "";
  var items = [];
  var left = -1;

  extraParams = _.clone(extraParams);
  if (extraParams && extraParams.limit) {
    left = extraParams.limit;
    delete extraParams.limit;
  }

  while (pageToken !== null) {
    try {
      self._ensureToken();
      increaseFacts();
      var r = HTTP.get(url, { params: _.extend({
        'access_token': self.credentials.accessToken,
        'pageToken': pageToken
      }, extraParams) });

      pageToken = r.data.nextPageToken || null;

      var newItems = transform(r.data, left);
      if (left !== -1)
        left -= newItems.length;

      // save the results into messages
      [].push.apply(items, newItems);

      // fetched the needed amount of items
      if (! left)
        break;
    } catch (err) {
      cb(err);
      return;
    }
  }

  cb(null, items);
});

var increaseFacts = function () {
  Package.facts && Package.facts.Facts.incrementServerFact(
    "slava:gmail", "api-calls-issued", 1);
};

