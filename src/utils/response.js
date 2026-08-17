export const successResponse = (
  res,
  data = null,
  message = "Success",
  statusCode = 200,
  pagination = null
) => {
  const count = Array.isArray(data) ? data.length : data == null ? 0 : 1;

  return res.status(statusCode).json({
    success: true,
    message,
    count,
    data,
    ...(pagination ? { pagination } : {}),
  });
};

export const errorResponse = (
  res,
  message = "Something went wrong.",
  statusCode = 500,
  errors = null
) => {
  return res.status(statusCode).json({
    success: false,
    message,
    errors,
  });
};

export const intelligenceResponse = (
  res,
  orders = [],
  subscriptions = [],
  cursor = undefined,
  metadata = undefined
) => {
  return res.status(200).json({
    success: true,
    orders,
    subscriptions,
    ...(cursor !== undefined ? { pagination: { cursor } } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
};
