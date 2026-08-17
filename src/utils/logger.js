const getTimestamp = () => {
  return new Date().toISOString();
};

const logger = {
  info(message, data = null) {
    console.log(
      `[INFO] ${getTimestamp()} | ${message}`,
      data ? data : ""
    );
  },

  success(message, data = null) {
    console.log(
      `[SUCCESS] ${getTimestamp()} | ${message}`,
      data ? data : ""
    );
  },

  warn(message, data = null) {
    console.warn(
      `[WARNING] ${getTimestamp()} | ${message}`,
      data ? data : ""
    );
  },

  error(message, error = null) {
    console.error(
      `[ERROR] ${getTimestamp()} | ${message}`
    );

    if (error) {
      console.error(error);
    }
  },
};

export default logger;