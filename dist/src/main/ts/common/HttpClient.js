"use strict";var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");Object.defineProperty(exports, "__esModule", { value: true });exports.default = void 0;var _GenUtils = _interopRequireDefault(require("./GenUtils"));
var _LibraryUtils = _interopRequireDefault(require("./LibraryUtils"));
var _ThreadPool = _interopRequireDefault(require("./ThreadPool"));
var _promiseThrottle = _interopRequireDefault(require("promise-throttle"));
var _http = _interopRequireDefault(require("http"));
var _https = _interopRequireDefault(require("https"));
var _axios = _interopRequireDefault(require("axios"));

/**
 * Handle HTTP requests with a uniform interface.
 */
class HttpClient {

  static MAX_REQUESTS_PER_SECOND = 50;

  // default request config
  static DEFAULT_REQUEST = {
    method: "GET",
    resolveWithFullResponse: false,
    rejectUnauthorized: true
  };

  // rate limit requests per host
  static PROMISE_THROTTLES = [];
  static TASK_QUEUES = [];
  static DEFAULT_TIMEOUT = 60000;
  static MAX_TIMEOUT = 2147483647; // max 32-bit signed number




  /**
   * <p>Make a HTTP request.<p>
   * 
   * @param {object} request - configures the request to make
   * @param {string} request.method - HTTP method ("GET", "PUT", "POST", "DELETE", etc)
   * @param {string} request.uri - uri to request
   * @param {string|Uint8Array|object} request.body - request body
   * @param {string} [request.username] - username to authenticate the request (optional)
   * @param {string} [request.password] - password to authenticate the request (optional)
   * @param {object} [request.headers] - headers to add to the request (optional)
   * @param {boolean} [request.resolveWithFullResponse] - return full response if true, else body only (default false)
   * @param {boolean} [request.rejectUnauthorized] - whether or not to reject self-signed certificates (default true)
   * @param {number} request.timeout - maximum time allowed in milliseconds
   * @param {number} request.proxyToWorker - proxy request to worker thread
   * @return {object} response - the response object
   * @return {string|Uint8Array|object} response.body - the response body
   * @return {number} response.statusCode - the response code
   * @return {String} response.statusText - the response message
   * @return {object} response.headers - the response headers
   */
  static async request(request) {
    // proxy to worker if configured
    if (request.proxyToWorker) {
      try {
        return await _LibraryUtils.default.invokeWorker(undefined, "httpRequest", request);
      } catch (err) {
        if (err.message.length > 0 && err.message.charAt(0) === "{") {
          let parsed = JSON.parse(err.message);
          err.message = parsed.statusMessage;
          err.statusCode = parsed.statusCode;
        }
        throw err;
      }
    }

    // assign defaults
    request = Object.assign({}, HttpClient.DEFAULT_REQUEST, request);

    // validate request
    try {request.host = new URL(request.uri).host;} // hostname:port
    catch (err) {throw new Error("Invalid request URL: " + request.uri);}
    if (request.body && !(typeof request.body === "string" || typeof request.body === "object")) {
      throw new Error("Request body type is not string or object");
    }

    // initialize one task queue per host
    if (!HttpClient.TASK_QUEUES[request.host]) HttpClient.TASK_QUEUES[request.host] = new _ThreadPool.default(1);

    // initialize one promise throttle per host
    if (!HttpClient.PROMISE_THROTTLES[request.host]) {
      HttpClient.PROMISE_THROTTLES[request.host] = new _promiseThrottle.default({
        requestsPerSecond: HttpClient.MAX_REQUESTS_PER_SECOND, // TODO: HttpClient should not depend on MoneroUtils for configuration
        promiseImplementation: Promise
      });
    }

    // request using fetch or xhr with timeout
    let timeout = request.timeout === undefined ? HttpClient.DEFAULT_TIMEOUT : request.timeout === 0 ? HttpClient.MAX_TIMEOUT : request.timeout;
    let requestPromise = HttpClient.requestAxios(request);
    return _GenUtils.default.executeWithTimeout(requestPromise, timeout);
  }

  // ----------------------------- PRIVATE HELPERS ----------------------------


  /**
   * Get a singleton instance of an HTTP client to share.
   *
   * @return {http.Agent} a shared agent for network requests among library instances
   */
  static getHttpAgent() {
    if (!HttpClient.HTTP_AGENT) HttpClient.HTTP_AGENT = new _http.default.Agent({
      keepAlive: true,
      family: 4 // use IPv4
    });
    return HttpClient.HTTP_AGENT;
  }

  /**
   * Get a singleton instance of an HTTPS client to share.
   *
   * @return {https.Agent} a shared agent for network requests among library instances
   */
  static getHttpsAgent() {
    if (!HttpClient.HTTPS_AGENT) HttpClient.HTTPS_AGENT = new _https.default.Agent({
      keepAlive: true,
      family: 4 // use IPv4
    });
    return HttpClient.HTTPS_AGENT;
  }

  static async requestAxios(req) {
    if (req.headers) throw new Error("Custom headers not implemented in XHR request"); // TODO

    // collect params from request which change on await
    const method = req.method;
    const uri = req.uri;
    const host = req.host;
    const username = req.username;
    const password = req.password;
    const body = req.body;
    const isBinary = body instanceof Uint8Array;

    // queue and throttle requests to execute in serial and rate limited per host
    const resp = await HttpClient.TASK_QUEUES[host].submit(async function () {
      return HttpClient.PROMISE_THROTTLES[host].add(function () {
        return new Promise(function (resolve, reject) {
          HttpClient.axiosDigestAuthRequest(method, uri, username, password, body).then(function (resp) {
            resolve(resp);
          }).catch(function (error) {
            if (error.response?.status) resolve(error.response);
            reject(new Error("Request failed without response: " + method + " " + uri + " due to underlying error:\n" + error.message + "\n" + error.stack));
          });
        });

      }.bind(this));
    });

    // normalize response
    let normalizedResponse = {};
    normalizedResponse.statusCode = resp.status;
    normalizedResponse.statusText = resp.statusText;
    normalizedResponse.headers = { ...resp.headers };
    normalizedResponse.body = isBinary ? new Uint8Array(resp.data) : resp.data;
    if (normalizedResponse.body instanceof ArrayBuffer) normalizedResponse.body = new Uint8Array(normalizedResponse.body); // handle empty binary request
    return normalizedResponse;
  }

  static axiosDigestAuthRequest = async function (method, url, username, password, body) {
    if (typeof CryptoJS === 'undefined' && typeof require === 'function') {
      var CryptoJS = require('crypto-js');
    }

    const generateCnonce = function () {
      const characters = 'abcdef0123456789';
      let token = '';
      for (let i = 0; i < 16; i++) {
        const randNum = Math.round(Math.random() * characters.length);
        token += characters.slice(randNum, randNum + 1);
      }
      return token;
    };

    let count = 0;
    return _axios.default.request({
      url: url,
      method: method,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json'
      },
      responseType: body instanceof Uint8Array ? 'arraybuffer' : undefined,
      httpAgent: url.startsWith("https") ? undefined : HttpClient.getHttpAgent(),
      httpsAgent: url.startsWith("https") ? HttpClient.getHttpsAgent() : undefined,
      data: body,
      transformResponse: (res) => res,
      adapter: ['http', 'xhr', 'fetch']
    }).catch(async (err) => {
      if (err.response?.status === 401) {
        let authHeader = err.response.headers['www-authenticate'].replace(/,\sDigest.*/, "");
        if (!authHeader) {
          throw err;
        }

        // Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="hBZ2rZIxElv4lqCRrUylXA==",stale=false
        const authHeaderMap = authHeader.replace("Digest ", "").replaceAll('"', "").split(",").reduce((prev, curr) => ({ ...prev, [curr.split("=")[0]]: curr.split("=").slice(1).join('=') }), {});

        ++count;

        const cnonce = generateCnonce();
        const HA1 = CryptoJS.MD5(username + ':' + authHeaderMap.realm + ':' + password).toString();
        const HA2 = CryptoJS.MD5(method + ':' + url).toString();

        const response = CryptoJS.MD5(HA1 + ':' +
        authHeaderMap.nonce + ':' +
        ('00000000' + count).slice(-8) + ':' +
        cnonce + ':' +
        authHeaderMap.qop + ':' +
        HA2).toString();
        const digestAuthHeader = 'Digest' + ' ' +
        'username="' + username + '", ' +
        'realm="' + authHeaderMap.realm + '", ' +
        'nonce="' + authHeaderMap.nonce + '", ' +
        'uri="' + url + '", ' +
        'response="' + response + '", ' +
        'opaque="' + (authHeaderMap.opaque ?? null) + '", ' +
        'qop=' + authHeaderMap.qop + ', ' +
        'nc=' + ('00000000' + count).slice(-8) + ', ' +
        'cnonce="' + cnonce + '"';

        const finalResponse = await _axios.default.request({
          url: url,
          method: method,
          timeout: this.timeout,
          headers: {
            'Authorization': digestAuthHeader,
            'Content-Type': 'application/json'
          },
          responseType: body instanceof Uint8Array ? 'arraybuffer' : undefined,
          httpAgent: url.startsWith("https") ? undefined : HttpClient.getHttpAgent(),
          httpsAgent: url.startsWith("https") ? HttpClient.getHttpsAgent() : undefined,
          data: body,
          transformResponse: (res) => res,
          adapter: ['http', 'xhr', 'fetch']
        });

        return finalResponse;
      }
      throw err;
    }).catch((err) => {
      throw err;
    });
  };
}exports.default = HttpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfR2VuVXRpbHMiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9MaWJyYXJ5VXRpbHMiLCJfVGhyZWFkUG9vbCIsIl9wcm9taXNlVGhyb3R0bGUiLCJfaHR0cCIsIl9odHRwcyIsIl9heGlvcyIsIkh0dHBDbGllbnQiLCJNQVhfUkVRVUVTVFNfUEVSX1NFQ09ORCIsIkRFRkFVTFRfUkVRVUVTVCIsIm1ldGhvZCIsInJlc29sdmVXaXRoRnVsbFJlc3BvbnNlIiwicmVqZWN0VW5hdXRob3JpemVkIiwiUFJPTUlTRV9USFJPVFRMRVMiLCJUQVNLX1FVRVVFUyIsIkRFRkFVTFRfVElNRU9VVCIsIk1BWF9USU1FT1VUIiwicmVxdWVzdCIsInByb3h5VG9Xb3JrZXIiLCJMaWJyYXJ5VXRpbHMiLCJpbnZva2VXb3JrZXIiLCJ1bmRlZmluZWQiLCJlcnIiLCJtZXNzYWdlIiwibGVuZ3RoIiwiY2hhckF0IiwicGFyc2VkIiwiSlNPTiIsInBhcnNlIiwic3RhdHVzTWVzc2FnZSIsInN0YXR1c0NvZGUiLCJPYmplY3QiLCJhc3NpZ24iLCJob3N0IiwiVVJMIiwidXJpIiwiRXJyb3IiLCJib2R5IiwiVGhyZWFkUG9vbCIsIlByb21pc2VUaHJvdHRsZSIsInJlcXVlc3RzUGVyU2Vjb25kIiwicHJvbWlzZUltcGxlbWVudGF0aW9uIiwiUHJvbWlzZSIsInRpbWVvdXQiLCJyZXF1ZXN0UHJvbWlzZSIsInJlcXVlc3RBeGlvcyIsIkdlblV0aWxzIiwiZXhlY3V0ZVdpdGhUaW1lb3V0IiwiZ2V0SHR0cEFnZW50IiwiSFRUUF9BR0VOVCIsImh0dHAiLCJBZ2VudCIsImtlZXBBbGl2ZSIsImZhbWlseSIsImdldEh0dHBzQWdlbnQiLCJIVFRQU19BR0VOVCIsImh0dHBzIiwicmVxIiwiaGVhZGVycyIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJpc0JpbmFyeSIsIlVpbnQ4QXJyYXkiLCJyZXNwIiwic3VibWl0IiwiYWRkIiwicmVzb2x2ZSIsInJlamVjdCIsImF4aW9zRGlnZXN0QXV0aFJlcXVlc3QiLCJ0aGVuIiwiY2F0Y2giLCJlcnJvciIsInJlc3BvbnNlIiwic3RhdHVzIiwic3RhY2siLCJiaW5kIiwibm9ybWFsaXplZFJlc3BvbnNlIiwic3RhdHVzVGV4dCIsImRhdGEiLCJBcnJheUJ1ZmZlciIsInVybCIsIkNyeXB0b0pTIiwiZ2VuZXJhdGVDbm9uY2UiLCJjaGFyYWN0ZXJzIiwidG9rZW4iLCJpIiwicmFuZE51bSIsIk1hdGgiLCJyb3VuZCIsInJhbmRvbSIsInNsaWNlIiwiY291bnQiLCJheGlvcyIsInJlc3BvbnNlVHlwZSIsImh0dHBBZ2VudCIsInN0YXJ0c1dpdGgiLCJodHRwc0FnZW50IiwidHJhbnNmb3JtUmVzcG9uc2UiLCJyZXMiLCJhZGFwdGVyIiwiYXV0aEhlYWRlciIsInJlcGxhY2UiLCJhdXRoSGVhZGVyTWFwIiwicmVwbGFjZUFsbCIsInNwbGl0IiwicmVkdWNlIiwicHJldiIsImN1cnIiLCJqb2luIiwiY25vbmNlIiwiSEExIiwiTUQ1IiwicmVhbG0iLCJ0b1N0cmluZyIsIkhBMiIsIm5vbmNlIiwicW9wIiwiZGlnZXN0QXV0aEhlYWRlciIsIm9wYXF1ZSIsImZpbmFsUmVzcG9uc2UiLCJleHBvcnRzIiwiZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9tYWluL3RzL2NvbW1vbi9IdHRwQ2xpZW50LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBHZW5VdGlscyBmcm9tIFwiLi9HZW5VdGlsc1wiO1xuaW1wb3J0IExpYnJhcnlVdGlscyBmcm9tIFwiLi9MaWJyYXJ5VXRpbHNcIjtcbmltcG9ydCBUaHJlYWRQb29sIGZyb20gXCIuL1RocmVhZFBvb2xcIjtcbmltcG9ydCBQcm9taXNlVGhyb3R0bGUgZnJvbSBcInByb21pc2UtdGhyb3R0bGVcIjtcbmltcG9ydCBodHRwIGZyb20gXCJodHRwXCI7XG5pbXBvcnQgaHR0cHMgZnJvbSBcImh0dHBzXCI7XG5pbXBvcnQgYXhpb3MsIHsgQXhpb3NFcnJvciB9IGZyb20gXCJheGlvc1wiO1xuXG4vKipcbiAqIEhhbmRsZSBIVFRQIHJlcXVlc3RzIHdpdGggYSB1bmlmb3JtIGludGVyZmFjZS5cbiAqL1xuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSHR0cENsaWVudCB7XG5cbiAgc3RhdGljIE1BWF9SRVFVRVNUU19QRVJfU0VDT05EID0gNTA7XG5cbiAgLy8gZGVmYXVsdCByZXF1ZXN0IGNvbmZpZ1xuICBwcm90ZWN0ZWQgc3RhdGljIERFRkFVTFRfUkVRVUVTVCA9IHtcbiAgICBtZXRob2Q6IFwiR0VUXCIsXG4gICAgcmVzb2x2ZVdpdGhGdWxsUmVzcG9uc2U6IGZhbHNlLFxuICAgIHJlamVjdFVuYXV0aG9yaXplZDogdHJ1ZVxuICB9XG5cbiAgLy8gcmF0ZSBsaW1pdCByZXF1ZXN0cyBwZXIgaG9zdFxuICBwcm90ZWN0ZWQgc3RhdGljIFBST01JU0VfVEhST1RUTEVTID0gW107XG4gIHByb3RlY3RlZCBzdGF0aWMgVEFTS19RVUVVRVMgPSBbXTtcbiAgcHJvdGVjdGVkIHN0YXRpYyBERUZBVUxUX1RJTUVPVVQgPSA2MDAwMDtcbiAgc3RhdGljIE1BWF9USU1FT1VUID0gMjE0NzQ4MzY0NzsgLy8gbWF4IDMyLWJpdCBzaWduZWQgbnVtYmVyXG5cbiAgcHJvdGVjdGVkIHN0YXRpYyBIVFRQX0FHRU5UOiBhbnk7XG4gIHByb3RlY3RlZCBzdGF0aWMgSFRUUFNfQUdFTlQ6IGFueTtcblxuICAvKipcbiAgICogPHA+TWFrZSBhIEhUVFAgcmVxdWVzdC48cD5cbiAgICogXG4gICAqIEBwYXJhbSB7b2JqZWN0fSByZXF1ZXN0IC0gY29uZmlndXJlcyB0aGUgcmVxdWVzdCB0byBtYWtlXG4gICAqIEBwYXJhbSB7c3RyaW5nfSByZXF1ZXN0Lm1ldGhvZCAtIEhUVFAgbWV0aG9kIChcIkdFVFwiLCBcIlBVVFwiLCBcIlBPU1RcIiwgXCJERUxFVEVcIiwgZXRjKVxuICAgKiBAcGFyYW0ge3N0cmluZ30gcmVxdWVzdC51cmkgLSB1cmkgdG8gcmVxdWVzdFxuICAgKiBAcGFyYW0ge3N0cmluZ3xVaW50OEFycmF5fG9iamVjdH0gcmVxdWVzdC5ib2R5IC0gcmVxdWVzdCBib2R5XG4gICAqIEBwYXJhbSB7c3RyaW5nfSBbcmVxdWVzdC51c2VybmFtZV0gLSB1c2VybmFtZSB0byBhdXRoZW50aWNhdGUgdGhlIHJlcXVlc3QgKG9wdGlvbmFsKVxuICAgKiBAcGFyYW0ge3N0cmluZ30gW3JlcXVlc3QucGFzc3dvcmRdIC0gcGFzc3dvcmQgdG8gYXV0aGVudGljYXRlIHRoZSByZXF1ZXN0IChvcHRpb25hbClcbiAgICogQHBhcmFtIHtvYmplY3R9IFtyZXF1ZXN0LmhlYWRlcnNdIC0gaGVhZGVycyB0byBhZGQgdG8gdGhlIHJlcXVlc3QgKG9wdGlvbmFsKVxuICAgKiBAcGFyYW0ge2Jvb2xlYW59IFtyZXF1ZXN0LnJlc29sdmVXaXRoRnVsbFJlc3BvbnNlXSAtIHJldHVybiBmdWxsIHJlc3BvbnNlIGlmIHRydWUsIGVsc2UgYm9keSBvbmx5IChkZWZhdWx0IGZhbHNlKVxuICAgKiBAcGFyYW0ge2Jvb2xlYW59IFtyZXF1ZXN0LnJlamVjdFVuYXV0aG9yaXplZF0gLSB3aGV0aGVyIG9yIG5vdCB0byByZWplY3Qgc2VsZi1zaWduZWQgY2VydGlmaWNhdGVzIChkZWZhdWx0IHRydWUpXG4gICAqIEBwYXJhbSB7bnVtYmVyfSByZXF1ZXN0LnRpbWVvdXQgLSBtYXhpbXVtIHRpbWUgYWxsb3dlZCBpbiBtaWxsaXNlY29uZHNcbiAgICogQHBhcmFtIHtudW1iZXJ9IHJlcXVlc3QucHJveHlUb1dvcmtlciAtIHByb3h5IHJlcXVlc3QgdG8gd29ya2VyIHRocmVhZFxuICAgKiBAcmV0dXJuIHtvYmplY3R9IHJlc3BvbnNlIC0gdGhlIHJlc3BvbnNlIG9iamVjdFxuICAgKiBAcmV0dXJuIHtzdHJpbmd8VWludDhBcnJheXxvYmplY3R9IHJlc3BvbnNlLmJvZHkgLSB0aGUgcmVzcG9uc2UgYm9keVxuICAgKiBAcmV0dXJuIHtudW1iZXJ9IHJlc3BvbnNlLnN0YXR1c0NvZGUgLSB0aGUgcmVzcG9uc2UgY29kZVxuICAgKiBAcmV0dXJuIHtTdHJpbmd9IHJlc3BvbnNlLnN0YXR1c1RleHQgLSB0aGUgcmVzcG9uc2UgbWVzc2FnZVxuICAgKiBAcmV0dXJuIHtvYmplY3R9IHJlc3BvbnNlLmhlYWRlcnMgLSB0aGUgcmVzcG9uc2UgaGVhZGVyc1xuICAgKi9cbiAgc3RhdGljIGFzeW5jIHJlcXVlc3QocmVxdWVzdCkge1xuICAgIC8vIHByb3h5IHRvIHdvcmtlciBpZiBjb25maWd1cmVkXG4gICAgaWYgKHJlcXVlc3QucHJveHlUb1dvcmtlcikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IExpYnJhcnlVdGlscy5pbnZva2VXb3JrZXIodW5kZWZpbmVkLCBcImh0dHBSZXF1ZXN0XCIsIHJlcXVlc3QpO1xuICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcbiAgICAgICAgaWYgKGVyci5tZXNzYWdlLmxlbmd0aCA+IDAgJiYgZXJyLm1lc3NhZ2UuY2hhckF0KDApID09PSBcIntcIikge1xuICAgICAgICAgIGxldCBwYXJzZWQgPSBKU09OLnBhcnNlKGVyci5tZXNzYWdlKTtcbiAgICAgICAgICBlcnIubWVzc2FnZSA9IHBhcnNlZC5zdGF0dXNNZXNzYWdlO1xuICAgICAgICAgIGVyci5zdGF0dXNDb2RlID0gcGFyc2VkLnN0YXR1c0NvZGU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIGFzc2lnbiBkZWZhdWx0c1xuICAgIHJlcXVlc3QgPSBPYmplY3QuYXNzaWduKHt9LCBIdHRwQ2xpZW50LkRFRkFVTFRfUkVRVUVTVCwgcmVxdWVzdCk7XG5cbiAgICAvLyB2YWxpZGF0ZSByZXF1ZXN0XG4gICAgdHJ5IHsgcmVxdWVzdC5ob3N0ID0gbmV3IFVSTChyZXF1ZXN0LnVyaSkuaG9zdDsgfSAvLyBob3N0bmFtZTpwb3J0XG4gICAgY2F0Y2ggKGVycikgeyB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHJlcXVlc3QgVVJMOiBcIiArIHJlcXVlc3QudXJpKTsgfVxuICAgIGlmIChyZXF1ZXN0LmJvZHkgJiYgISh0eXBlb2YgcmVxdWVzdC5ib2R5ID09PSBcInN0cmluZ1wiIHx8IHR5cGVvZiByZXF1ZXN0LmJvZHkgPT09IFwib2JqZWN0XCIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IGJvZHkgdHlwZSBpcyBub3Qgc3RyaW5nIG9yIG9iamVjdFwiKTtcbiAgICB9XG5cbiAgICAvLyBpbml0aWFsaXplIG9uZSB0YXNrIHF1ZXVlIHBlciBob3N0XG4gICAgaWYgKCFIdHRwQ2xpZW50LlRBU0tfUVVFVUVTW3JlcXVlc3QuaG9zdF0pIEh0dHBDbGllbnQuVEFTS19RVUVVRVNbcmVxdWVzdC5ob3N0XSA9IG5ldyBUaHJlYWRQb29sKDEpO1xuXG4gICAgLy8gaW5pdGlhbGl6ZSBvbmUgcHJvbWlzZSB0aHJvdHRsZSBwZXIgaG9zdFxuICAgIGlmICghSHR0cENsaWVudC5QUk9NSVNFX1RIUk9UVExFU1tyZXF1ZXN0Lmhvc3RdKSB7XG4gICAgICBIdHRwQ2xpZW50LlBST01JU0VfVEhST1RUTEVTW3JlcXVlc3QuaG9zdF0gPSBuZXcgUHJvbWlzZVRocm90dGxlKHtcbiAgICAgICAgcmVxdWVzdHNQZXJTZWNvbmQ6IEh0dHBDbGllbnQuTUFYX1JFUVVFU1RTX1BFUl9TRUNPTkQsIC8vIFRPRE86IEh0dHBDbGllbnQgc2hvdWxkIG5vdCBkZXBlbmQgb24gTW9uZXJvVXRpbHMgZm9yIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgcHJvbWlzZUltcGxlbWVudGF0aW9uOiBQcm9taXNlXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyByZXF1ZXN0IHVzaW5nIGZldGNoIG9yIHhociB3aXRoIHRpbWVvdXRcbiAgICBsZXQgdGltZW91dCA9IHJlcXVlc3QudGltZW91dCA9PT0gdW5kZWZpbmVkID8gSHR0cENsaWVudC5ERUZBVUxUX1RJTUVPVVQgOiByZXF1ZXN0LnRpbWVvdXQgPT09IDAgPyBIdHRwQ2xpZW50Lk1BWF9USU1FT1VUIDogcmVxdWVzdC50aW1lb3V0O1xuICAgIGxldCByZXF1ZXN0UHJvbWlzZSA9IEh0dHBDbGllbnQucmVxdWVzdEF4aW9zKHJlcXVlc3QpO1xuICAgIHJldHVybiBHZW5VdGlscy5leGVjdXRlV2l0aFRpbWVvdXQocmVxdWVzdFByb21pc2UsIHRpbWVvdXQpO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gUFJJVkFURSBIRUxQRVJTIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXG4gIC8qKlxuICAgKiBHZXQgYSBzaW5nbGV0b24gaW5zdGFuY2Ugb2YgYW4gSFRUUCBjbGllbnQgdG8gc2hhcmUuXG4gICAqXG4gICAqIEByZXR1cm4ge2h0dHAuQWdlbnR9IGEgc2hhcmVkIGFnZW50IGZvciBuZXR3b3JrIHJlcXVlc3RzIGFtb25nIGxpYnJhcnkgaW5zdGFuY2VzXG4gICAqL1xuICBwcm90ZWN0ZWQgc3RhdGljIGdldEh0dHBBZ2VudCgpIHtcbiAgICBpZiAoIUh0dHBDbGllbnQuSFRUUF9BR0VOVCkgSHR0cENsaWVudC5IVFRQX0FHRU5UID0gbmV3IGh0dHAuQWdlbnQoe1xuICAgICAga2VlcEFsaXZlOiB0cnVlLFxuICAgICAgZmFtaWx5OiA0IC8vIHVzZSBJUHY0XG4gICAgfSk7XG4gICAgcmV0dXJuIEh0dHBDbGllbnQuSFRUUF9BR0VOVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgYSBzaW5nbGV0b24gaW5zdGFuY2Ugb2YgYW4gSFRUUFMgY2xpZW50IHRvIHNoYXJlLlxuICAgKlxuICAgKiBAcmV0dXJuIHtodHRwcy5BZ2VudH0gYSBzaGFyZWQgYWdlbnQgZm9yIG5ldHdvcmsgcmVxdWVzdHMgYW1vbmcgbGlicmFyeSBpbnN0YW5jZXNcbiAgICovXG4gIHByb3RlY3RlZCBzdGF0aWMgZ2V0SHR0cHNBZ2VudCgpIHtcbiAgICBpZiAoIUh0dHBDbGllbnQuSFRUUFNfQUdFTlQpIEh0dHBDbGllbnQuSFRUUFNfQUdFTlQgPSBuZXcgaHR0cHMuQWdlbnQoe1xuICAgICAga2VlcEFsaXZlOiB0cnVlLFxuICAgICAgZmFtaWx5OiA0IC8vIHVzZSBJUHY0XG4gICAgfSk7XG4gICAgcmV0dXJuIEh0dHBDbGllbnQuSFRUUFNfQUdFTlQ7XG4gIH1cblxuICBwcm90ZWN0ZWQgc3RhdGljIGFzeW5jIHJlcXVlc3RBeGlvcyhyZXEpIHtcbiAgICBpZiAocmVxLmhlYWRlcnMpIHRocm93IG5ldyBFcnJvcihcIkN1c3RvbSBoZWFkZXJzIG5vdCBpbXBsZW1lbnRlZCBpbiBYSFIgcmVxdWVzdFwiKTsgIC8vIFRPRE9cblxuICAgIC8vIGNvbGxlY3QgcGFyYW1zIGZyb20gcmVxdWVzdCB3aGljaCBjaGFuZ2Ugb24gYXdhaXRcbiAgICBjb25zdCBtZXRob2QgPSByZXEubWV0aG9kO1xuICAgIGNvbnN0IHVyaSA9IHJlcS51cmk7XG4gICAgY29uc3QgaG9zdCA9IHJlcS5ob3N0O1xuICAgIGNvbnN0IHVzZXJuYW1lID0gcmVxLnVzZXJuYW1lO1xuICAgIGNvbnN0IHBhc3N3b3JkID0gcmVxLnBhc3N3b3JkO1xuICAgIGNvbnN0IGJvZHkgPSByZXEuYm9keTtcbiAgICBjb25zdCBpc0JpbmFyeSA9IGJvZHkgaW5zdGFuY2VvZiBVaW50OEFycmF5O1xuXG4gICAgLy8gcXVldWUgYW5kIHRocm90dGxlIHJlcXVlc3RzIHRvIGV4ZWN1dGUgaW4gc2VyaWFsIGFuZCByYXRlIGxpbWl0ZWQgcGVyIGhvc3RcbiAgICBjb25zdCByZXNwID0gYXdhaXQgSHR0cENsaWVudC5UQVNLX1FVRVVFU1tob3N0XS5zdWJtaXQoYXN5bmMgZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gSHR0cENsaWVudC5QUk9NSVNFX1RIUk9UVExFU1tob3N0XS5hZGQoZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICAgICAgICBIdHRwQ2xpZW50LmF4aW9zRGlnZXN0QXV0aFJlcXVlc3QobWV0aG9kLCB1cmksIHVzZXJuYW1lLCBwYXNzd29yZCwgYm9keSkudGhlbihmdW5jdGlvbihyZXNwKSB7XG4gICAgICAgICAgICByZXNvbHZlKHJlc3ApO1xuICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKGVycm9yOiBBeGlvc0Vycm9yKSB7XG4gICAgICAgICAgICBpZiAoZXJyb3IucmVzcG9uc2U/LnN0YXR1cykgcmVzb2x2ZShlcnJvci5yZXNwb25zZSk7XG4gICAgICAgICAgICByZWplY3QobmV3IEVycm9yKFwiUmVxdWVzdCBmYWlsZWQgd2l0aG91dCByZXNwb25zZTogXCIgKyBtZXRob2QgKyBcIiBcIiArIHVyaSArIFwiIGR1ZSB0byB1bmRlcmx5aW5nIGVycm9yOlxcblwiICsgZXJyb3IubWVzc2FnZSArIFwiXFxuXCIgKyBlcnJvci5zdGFjaykpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgfS5iaW5kKHRoaXMpKTtcbiAgICB9KTtcblxuICAgIC8vIG5vcm1hbGl6ZSByZXNwb25zZVxuICAgIGxldCBub3JtYWxpemVkUmVzcG9uc2U6IGFueSA9IHt9O1xuICAgIG5vcm1hbGl6ZWRSZXNwb25zZS5zdGF0dXNDb2RlID0gcmVzcC5zdGF0dXM7XG4gICAgbm9ybWFsaXplZFJlc3BvbnNlLnN0YXR1c1RleHQgPSByZXNwLnN0YXR1c1RleHQ7XG4gICAgbm9ybWFsaXplZFJlc3BvbnNlLmhlYWRlcnMgPSB7Li4ucmVzcC5oZWFkZXJzfTtcbiAgICBub3JtYWxpemVkUmVzcG9uc2UuYm9keSA9IGlzQmluYXJ5ID8gbmV3IFVpbnQ4QXJyYXkocmVzcC5kYXRhKSA6IHJlc3AuZGF0YTtcbiAgICBpZiAobm9ybWFsaXplZFJlc3BvbnNlLmJvZHkgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgbm9ybWFsaXplZFJlc3BvbnNlLmJvZHkgPSBuZXcgVWludDhBcnJheShub3JtYWxpemVkUmVzcG9uc2UuYm9keSk7ICAvLyBoYW5kbGUgZW1wdHkgYmluYXJ5IHJlcXVlc3RcbiAgICByZXR1cm4gbm9ybWFsaXplZFJlc3BvbnNlO1xuICB9XG5cbiAgcHJvdGVjdGVkIHN0YXRpYyBheGlvc0RpZ2VzdEF1dGhSZXF1ZXN0ID0gYXN5bmMgZnVuY3Rpb24obWV0aG9kLCB1cmwsIHVzZXJuYW1lLCBwYXNzd29yZCwgYm9keSkge1xuICAgIGlmICh0eXBlb2YgQ3J5cHRvSlMgPT09ICd1bmRlZmluZWQnICYmIHR5cGVvZiByZXF1aXJlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB2YXIgQ3J5cHRvSlMgPSByZXF1aXJlKCdjcnlwdG8tanMnKTtcbiAgICB9XG5cbiAgICBjb25zdCBnZW5lcmF0ZUNub25jZSA9IGZ1bmN0aW9uKCk6IHN0cmluZyB7XG4gICAgICBjb25zdCBjaGFyYWN0ZXJzID0gJ2FiY2RlZjAxMjM0NTY3ODknO1xuICAgICAgbGV0IHRva2VuID0gJyc7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDE2OyBpKyspIHtcbiAgICAgICAgY29uc3QgcmFuZE51bSA9IE1hdGgucm91bmQoTWF0aC5yYW5kb20oKSAqIGNoYXJhY3RlcnMubGVuZ3RoKTtcbiAgICAgICAgdG9rZW4gKz0gY2hhcmFjdGVycy5zbGljZShyYW5kTnVtLCByYW5kTnVtKzEpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRva2VuO1xuICAgIH1cblxuICAgIGxldCBjb3VudCA9IDA7XG4gICAgcmV0dXJuIGF4aW9zLnJlcXVlc3Qoe1xuICAgICAgdXJsOiB1cmwsXG4gICAgICBtZXRob2Q6IG1ldGhvZCxcbiAgICAgIHRpbWVvdXQ6IHRoaXMudGltZW91dCxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xuICAgICAgfSxcbiAgICAgIHJlc3BvbnNlVHlwZTogYm9keSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkgPyAnYXJyYXlidWZmZXInIDogdW5kZWZpbmVkLFxuICAgICAgaHR0cEFnZW50OiB1cmwuc3RhcnRzV2l0aChcImh0dHBzXCIpID8gdW5kZWZpbmVkIDogSHR0cENsaWVudC5nZXRIdHRwQWdlbnQoKSxcbiAgICAgIGh0dHBzQWdlbnQ6IHVybC5zdGFydHNXaXRoKFwiaHR0cHNcIikgPyBIdHRwQ2xpZW50LmdldEh0dHBzQWdlbnQoKSA6IHVuZGVmaW5lZCxcbiAgICAgIGRhdGE6IGJvZHksXG4gICAgICB0cmFuc2Zvcm1SZXNwb25zZTogcmVzID0+IHJlcyxcbiAgICAgIGFkYXB0ZXI6IFsnaHR0cCcsICd4aHInLCAnZmV0Y2gnXSxcbiAgICB9KS5jYXRjaChhc3luYyAoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyLnJlc3BvbnNlPy5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgICBsZXQgYXV0aEhlYWRlciA9IGVyci5yZXNwb25zZS5oZWFkZXJzWyd3d3ctYXV0aGVudGljYXRlJ10ucmVwbGFjZSgvLFxcc0RpZ2VzdC4qLywgXCJcIik7XG4gICAgICAgIGlmICghYXV0aEhlYWRlcikge1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIERpZ2VzdCBxb3A9XCJhdXRoXCIsYWxnb3JpdGhtPU1ENSxyZWFsbT1cIm1vbmVyby1ycGNcIixub25jZT1cImhCWjJyWkl4RWx2NGxxQ1JyVXlsWEE9PVwiLHN0YWxlPWZhbHNlXG4gICAgICAgIGNvbnN0IGF1dGhIZWFkZXJNYXAgPSBhdXRoSGVhZGVyLnJlcGxhY2UoXCJEaWdlc3QgXCIsIFwiXCIpLnJlcGxhY2VBbGwoJ1wiJywgXCJcIikuc3BsaXQoXCIsXCIpLnJlZHVjZSgocHJldiwgY3VycikgPT4gKHsuLi5wcmV2LCBbY3Vyci5zcGxpdChcIj1cIilbMF1dOiBjdXJyLnNwbGl0KFwiPVwiKS5zbGljZSgxKS5qb2luKCc9Jyl9KSwge30pXG5cbiAgICAgICAgKytjb3VudDtcblxuICAgICAgICBjb25zdCBjbm9uY2UgPSBnZW5lcmF0ZUNub25jZSgpO1xuICAgICAgICBjb25zdCBIQTEgPSBDcnlwdG9KUy5NRDUodXNlcm5hbWUrJzonK2F1dGhIZWFkZXJNYXAucmVhbG0rJzonK3Bhc3N3b3JkKS50b1N0cmluZygpO1xuICAgICAgICBjb25zdCBIQTIgPSBDcnlwdG9KUy5NRDUobWV0aG9kKyc6Jyt1cmwpLnRvU3RyaW5nKCk7XG5cbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBDcnlwdG9KUy5NRDUoSEExKyc6JytcbiAgICAgICAgICBhdXRoSGVhZGVyTWFwLm5vbmNlKyc6JytcbiAgICAgICAgICAoJzAwMDAwMDAwJyArIGNvdW50KS5zbGljZSgtOCkrJzonK1xuICAgICAgICAgIGNub25jZSsnOicrXG4gICAgICAgICAgYXV0aEhlYWRlck1hcC5xb3ArJzonK1xuICAgICAgICAgIEhBMikudG9TdHJpbmcoKTtcbiAgICAgICAgY29uc3QgZGlnZXN0QXV0aEhlYWRlciA9ICdEaWdlc3QnKycgJytcbiAgICAgICAgICAndXNlcm5hbWU9XCInK3VzZXJuYW1lKydcIiwgJytcbiAgICAgICAgICAncmVhbG09XCInK2F1dGhIZWFkZXJNYXAucmVhbG0rJ1wiLCAnK1xuICAgICAgICAgICdub25jZT1cIicrYXV0aEhlYWRlck1hcC5ub25jZSsnXCIsICcrXG4gICAgICAgICAgJ3VyaT1cIicrdXJsKydcIiwgJytcbiAgICAgICAgICAncmVzcG9uc2U9XCInK3Jlc3BvbnNlKydcIiwgJytcbiAgICAgICAgICAnb3BhcXVlPVwiJysoYXV0aEhlYWRlck1hcC5vcGFxdWUgPz8gbnVsbCkrJ1wiLCAnK1xuICAgICAgICAgICdxb3A9JythdXRoSGVhZGVyTWFwLnFvcCsnLCAnK1xuICAgICAgICAgICduYz0nKygnMDAwMDAwMDAnICsgY291bnQpLnNsaWNlKC04KSsnLCAnK1xuICAgICAgICAgICdjbm9uY2U9XCInK2Nub25jZSsnXCInO1xuXG4gICAgICAgIGNvbnN0IGZpbmFsUmVzcG9uc2UgPSBhd2FpdCBheGlvcy5yZXF1ZXN0KHtcbiAgICAgICAgICB1cmw6IHVybCxcbiAgICAgICAgICBtZXRob2Q6IG1ldGhvZCxcbiAgICAgICAgICB0aW1lb3V0OiB0aGlzLnRpbWVvdXQsXG4gICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBkaWdlc3RBdXRoSGVhZGVyLFxuICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVzcG9uc2VUeXBlOiBib2R5IGluc3RhbmNlb2YgVWludDhBcnJheSA/ICdhcnJheWJ1ZmZlcicgOiB1bmRlZmluZWQsXG4gICAgICAgICAgaHR0cEFnZW50OiB1cmwuc3RhcnRzV2l0aChcImh0dHBzXCIpID8gdW5kZWZpbmVkIDogSHR0cENsaWVudC5nZXRIdHRwQWdlbnQoKSxcbiAgICAgICAgICBodHRwc0FnZW50OiB1cmwuc3RhcnRzV2l0aChcImh0dHBzXCIpID8gSHR0cENsaWVudC5nZXRIdHRwc0FnZW50KCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgZGF0YTogYm9keSxcbiAgICAgICAgICB0cmFuc2Zvcm1SZXNwb25zZTogcmVzID0+IHJlcyxcbiAgICAgICAgICBhZGFwdGVyOiBbJ2h0dHAnLCAneGhyJywgJ2ZldGNoJ10sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBmaW5hbFJlc3BvbnNlO1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyO1xuICAgIH0pLmNhdGNoKGVyciA9PiB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfSk7XG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6InlMQUFBLElBQUFBLFNBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLGFBQUEsR0FBQUYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFFLFdBQUEsR0FBQUgsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFHLGdCQUFBLEdBQUFKLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSSxLQUFBLEdBQUFMLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSyxNQUFBLEdBQUFOLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBTSxNQUFBLEdBQUFQLHNC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