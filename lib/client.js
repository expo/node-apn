"use strict";

const VError = require("verror");
const extend = require("./util/extend");

module.exports = function (dependencies) {
  const {
    logger,
    config,
    http2
  } = dependencies;

  const {
    HTTP2_HEADER_STATUS,
    HTTP2_HEADER_SCHEME,
    HTTP2_HEADER_METHOD,
    HTTP2_HEADER_AUTHORITY,
    HTTP2_HEADER_PATH,
    HTTP2_METHOD_POST
  } = http2.constants;

  function Client (options) {
    this.config = config(options);
  }

  Client.prototype.write = function write (notification, device, count) {
    // Connect session
    if (!this.session || this.session.destroyed || this.session.closed) {
      this.session = http2.connect(`https://${this.config.address}`, this.config);

      this.session.on("socketError", (error) => {
        if (logger.enabled) {
          logger(`Socket error: ${error}`);
        }
        if (this.session && !this.session.destroyed) {
          this.session.destroy();
        }
      });
      this.session.on("error", (error) => {
        if (logger.enabled) {
          logger(`Session error: ${error}`);
        }
        if (this.session && !this.session.destroyed) {
          this.session.destroy();
        }
      });

      if (logger.enabled) {
        this.session.on("connect", () => {
          logger("Session connected");
        });
        this.session.on("close", () => {
          logger("Session closed");
        });
        this.session.on("frameError", (frameType, errorCode, streamId) => {
          logger(`Frame error: (frameType: ${frameType}, errorCode ${errorCode}, streamId: ${streamId})`);
        });
        this.session.on("goaway", (errorCode, lastStreamId, opaqueData) => {
          logger(`GOAWAY received: (errorCode ${errorCode}, lastStreamId: ${lastStreamId}, opaqueData: ${opaqueData})`);
        });
      }
    }

    let tokenGeneration = null;
    let status = null;
    let responseData = "";
    let retryCount = count || 0;

    const headers = extend({
      [HTTP2_HEADER_SCHEME]: "https",
      [HTTP2_HEADER_METHOD]: HTTP2_METHOD_POST,
      [HTTP2_HEADER_AUTHORITY]: this.config.address,
      [HTTP2_HEADER_PATH]: `/3/device/${device}`,
    }, notification.headers);

    if (this.config.token) {
      if (this.config.token.isExpired(3300)) {
        this.config.token.regenerate(this.config.token.generation);
      }
      headers.authorization = `bearer ${this.config.token.current}`;
      tokenGeneration = this.config.token.generation;
    }

    const request = this.session.request(headers)

    request.setEncoding("utf8");

    request.on("response", (headers) => {
      status = headers[HTTP2_HEADER_STATUS];
    });

    request.on("data", (data) => {
      responseData += data;
    });

    request.write(notification.body);

    return new Promise ( resolve => {
      // APNs sends a GOAWAY frame when it decides to terminate an HTTP/2
      // connection, which ends all streams after the last successfully
      // processed stream
      const handleGoaway = (errorCode, lastStreamId, opaqueData) => {
        // Pending streams cannot have been successfully processed before the
        // server sent the GOAWAY frame. The stream ID is initialized once it
        // is no longer pending.
        if (request.pending || request.id < lastStreamId) {
          if (logger.enabled) {
            logger(`Request ${request.id} ended early due to a GOAWAY frame for requests after ${lastStreamId}`);
          }

          const response = opaqueData ? JSON.parse(opaqueData.toString()) : undefined;
          const error = new VError("APNs terminated the connection");
          resolve({ device, error, response });
        }
      };
      this.session.once("goaway", handleGoaway);

      request.on("end", () => {
        if (logger.enabled) {
          logger(`Request ended with status ${status} and responseData: ${responseData}`);
        }

        this.session.removeListener("goaway", handleGoaway);

        if (status === 200) {
          resolve({ device });
        } else if (responseData !== "") {
          const response = JSON.parse(responseData);

          if (status === 403 && response.reason === "ExpiredProviderToken" && retryCount < 2) {
            this.config.token.regenerate(tokenGeneration);
            resolve(this.write(notification, device, retryCount + 1));
            return;
          } else if (status === 500 && response.reason === "InternalServerError") {
            this.session.destroy();
            let error = new VError("Error 500, stream ended unexpectedly");
            resolve({ device, error });
            return;
          }

          resolve({ device, status, response });
        } else {
          let error = new VError("stream ended unexpectedly");
          resolve({ device, error });
        }
      })

      request.on("error", (error) => {
        if (logger.enabled) {
          logger(`Request error: ${error}`);
        }

        this.session.removeListener("goaway", handleGoaway);

        if (typeof error === "string") {
          error = new VError("apn write failed: %s", err);
        } else {
          error = new VError(error, "apn write failed");
        }
        resolve({ device, error });
      });

      request.end();
    });
  };

  Client.prototype.shutdown = function shutdown(callback) {
    if (this.session && !this.session.destroyed) {
      this.session.shutdown({graceful: true}, () => {
        this.session.destroy();
        if (callback) {
          callback();
        }
      });
    }
  };

  return Client;
}
