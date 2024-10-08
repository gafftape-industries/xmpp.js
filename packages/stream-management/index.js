"use strict";

const xml = require("@xmpp/xml");

// https://xmpp.org/extensions/xep-0198.html

const NS = "urn:xmpp:sm:3";

async function enable(entity, resume, max) {
  await entity.send(
    xml("enable", { xmlns: NS, max, resume: resume ? "true" : undefined }),
  );

  return new Promise((resolve, reject) => {
    function listener(nonza) {
      if (nonza.is("enabled", NS)) {
        resolve(nonza);
      } else if (nonza.is("failed", NS)) {
        reject(nonza);
      } else {
        return;
      }

      entity.removeListener("nonza", listener);
    }

    entity.on("nonza", listener);
  });
}

async function resume(entity, h, previd) {
  const response = await entity.sendReceive(
    xml("resume", { xmlns: NS, h, previd }),
  );

  if (!response.is("resumed", NS)) {
    throw response;
  }

  return response;
}

module.exports = function streamManagement({
  streamFeatures,
  entity,
  middleware,
  sasl2,
}) {
  let address = null;

  const sm = {
    allowResume: true,
    preferredMaximum: null,
    enabled: false,
    id: "",
    outbound: 0,
    inbound: 0,
    max: null,
    sendAck: () => {
          if (sm.enabled && sm.inbound) {
            entity.send(xml("a", { xmlns: NS, h: sm.inbound })).catch(() => {});
          }
        }
  };

  entity.on("online", (jid) => {
    address = jid;
    sm.outbound = 0;
    sm.inbound = 0;
  });

  entity.on("offline", () => {
    sendAck();
    sm.outbound = 0;
    sm.inbound = 0;
    sm.enabled = false;
    sm.id = "";
  });

  middleware.use((context, next) => {
    const { stanza } = context;
    if (["presence", "message", "iq"].includes(stanza.name)) {
      sm.inbound += 1;
    } else if (stanza.is("r", NS)) {
      // > When an <r/> element ("request") is received, the recipient MUST acknowledge it by sending an <a/> element to the sender containing a value of 'h' that is equal to the number of stanzas handled by the recipient of the <r/> element.
      entity.send(xml("a", { xmlns: NS, h: sm.inbound })).catch(() => {});
    } else if (stanza.is("a", NS)) {
      // > When a party receives an <a/> element, it SHOULD keep a record of the 'h' value returned as the sequence number of the last handled outbound stanza for the current stream (and discard the previous value).
      sm.outbound = stanza.attrs.h;
    }

    return next();
  });

  // https://xmpp.org/extensions/xep-0198.html#enable
  // For client-to-server connections, the client MUST NOT attempt to enable stream management until after it has completed Resource Binding unless it is resuming a previous session

  const resumeSuccess = () => {
    sm.enabled = true;
    if (address) entity.jid = address;
    entity.status = "online";
  };

  const resumeFailed = () => {
    sm.id = "";
    sm.enabled = false;
    sm.outbound = 0;
  };

  streamFeatures.use("sm", NS, async (context, next) => {
    // Resuming
    if (sm.id) {
      try {
        resumeSuccess(await resume(entity, sm.inbound, sm.id));
        return true;
        // If resumption fails, continue with session establishment
        // eslint-disable-next-line no-unused-vars
      } catch {
        resumeFailed();
      }
    }
    // Enabling

    // Resource binding first
    await next();

    const promiseEnable = enable(entity, sm.allowResume, sm.preferredMaximum);

    // > The counter for an entity's own sent stanzas is set to zero and started after sending either <enable/> or <enabled/>.
    sm.outbound = 0;

    try {
      const response = await promiseEnable;
      sm.enabled = true;
      sm.id = response.attrs.id;
      sm.max = response.attrs.max;
      // eslint-disable-next-line no-unused-vars
    } catch {
      sm.enabled = false;
    }

    sm.inbound = 0;
  });

  sasl2?.inline("sm", NS, async (_, addInline) => {
    if (sm.id) {
      const success = await addInline(
        xml("resume", { xmlns: NS, h: sm.inbound, previd: sm.id }),
      );
      const resumed = success.getChild("resumed", NS);
      if (resumed) {
        resumeSuccess(resumed);
      } else {
        resumeFailed();
      }
    }
  });

  sasl2?.bindInline(NS, async (addInline) => {
    const success = await addInline(
      xml("enable", {
        xmlns: NS,
        max: sm.preferredMaximum,
        resume: sm.allowResume ? "true" : undefined,
      }),
    );
    const bound = success.getChild("bound", "urn:xmpp:bind:0");
    if (!bound) return; // Did a resume or something, don't need this

    const enabled = bound?.getChild("enabled", NS);
    if (enabled) {
      if (sm.outbound_q.length > 0) {
        throw "Stream Management assertion failure, queue should be empty after enable";
      }
      sm.outbound = 0;
      sm.enabled = true;
      sm.id = enabled.attrs.id;
      sm.max = enabled.attrs.max;
    } else {
      sm.enabled = false;
    }

    sm.inbound = 0;
  });

  return sm;
};
