const
  express = require('express'),
  rp = require('request-promise'),
  httpStatusCodes = require('../../utilities/constants/http-status-codes'),
  entryIdLabels = require('../../utilities/constants/entry-id-labels'),
  { parsePayload, processEntryId, processPayload } = require('../../utilities/event-handler'),
  queries = require('../../db/queries');

const router = express.Router();

router.route('/')
  .get((request, response) => {
    const webhookVerificationToken = process.env.WEBHOOK_VERIFICATION_TOKEN;

    const
      mode = request.query['hub.mode'],
      token = request.query['hub.verify_token'],
      challenge = request.query['hub.challenge'];

    if (!mode || !token) {
      return response.sendStatus(httpStatusCodes.unauthorized)
    }

    if (mode !== 'subscribe' || token !== webhookVerificationToken) {
      return response.sendStatus(httpStatusCodes.forbidden);
    }

    return response.status(httpStatusCodes.ok).send(challenge);
  })

  .post((request, response) => {
    const body = request.body;

    let entryId, event, senderId, payload, accessToken, eventId, userId;

    if (body.object !== 'page') {
      return response.sendStatus(httpStatusCodes.notFound);
    }

    body.entry.forEach((entry) => {
      entryId = entry.id; // thepage entry id
      accessToken = processEntryId(entryId); // gets access token by entry id
      event = entry.messaging[0]; // the webhook event
      senderId = event.sender.id; // the page-scoped id of event sender
      payload = parsePayload(event); // get payload based on event type
    });

    return queries.events.getByPageId(entryId)
      .then((result) => {
        const { id } = result.rows[0]; // id of events table

        eventId = id;

        return queries.users.fetchByPageUserId(senderId)
      })
      .then((result) => {
        const user = result.rows[0]; // id of users table

        if (!user) {
          return queries.users.insert(senderId, eventId);
        }

        user.existing = true;

        return { rows: [user] };
      })
      .then((result) => {
        userId = result.rows[0].id; // id of users table

        const
          existingUser = result.rows[0].existing,
          pageUserId = result.rows[0].page_user_id; // page scoped id

        if (!existingUser) {
          const attachLabelToUserOptions = {
            uri: `https://graph.facebook.com/v2.11/${entryIdLabels[entryId]}/label`,
            qs: {
              access_token: accessToken
            },
            method: 'POST',
            json: {
              user: pageUserId
            }
          }

          return rp(attachLabelToUserOptions);
        }

        return;
      })
      .then(() => {
        return processPayload(accessToken, payload, senderId, userId, eventId);
      })
      .catch((error) => {
        return queries.errors.logError(error.name, error.message, error.stack);
      })
      .finally(() => {
        // Returns a '200 OK' response to all requests
        return response.sendStatus(httpStatusCodes.ok);
      });
  });

module.exports = router;