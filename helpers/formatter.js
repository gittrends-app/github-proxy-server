/* Author: Hudson S. Borges */
const chalk = require('chalk');

module.exports = {
  object: (object, { colors = true, color } = {}) =>
    Object.keys(object)
      .reduce(
        (m, key) =>
          m.concat(
            `${key}: ${colors ? chalk[color || 'yellow'](object[key]) : object[key]}`
          ),
        []
      )
      .join(', ')
};
