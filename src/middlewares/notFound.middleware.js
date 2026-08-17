const notFound = (req, res, next) => {
  const error = new Error(`Route ${req.originalUrl} not found.`);
  error.statusCode = 404;
  error.errors = null;
  return next(error);
};

export default notFound;
