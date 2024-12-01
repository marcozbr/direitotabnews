import nextConnect from 'next-connect';

import authentication from 'models/authentication';
import authorization from 'models/authorization';
import cacheControl from 'models/cache-control';
import controller from 'models/controller';
import firewall from 'models/firewall';
import validator from 'models/validator';

export default nextConnect({
  attachParams: true,
  onNoMatch: controller.onNoMatchHandler,
  onError: controller.onErrorHandler,
})
  .use(controller.injectRequestMetadata)
  .use(controller.logRequest)
  .use(authentication.injectAnonymousOrUser)
  .get(cacheControl.noCache, getValidationHandler, authorization.canRequest('read:firewall'), getHandler);

function getValidationHandler(request, response, next) {
  const cleanValues = validator(request.query, {
    id: 'required',
  });

  request.query = cleanValues;

  next();
}

async function getHandler(request, response) {
  const userTryingToGet = request.context.user;

  const data = await firewall.findByEventId(request.query.id);

  const secureOutputValues = authorization.filterOutput(userTryingToGet, 'read:firewall', data);

  return response.status(200).json(secureOutputValues);
}
