var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var compression = require('compression');
var helmet = require('helmet');

var indexRouter = require('./routes/index');
var apiRouter = require('./routes/api');

var databaseController = require('./controllers/databaseController');

var app = express();

// set up mongoose
var mongoose = require('mongoose');
var mongoDBUrl = process.env.MONGODB_URI || 'mongodb://admin:hn_jobs_db@ds135540.mlab.com:35540/hn_jobs_db';
mongoose.connect(mongoDBUrl);
mongoose.Promise = global.Promise;
var db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(compression());
app.use(helmet());

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);

app.use('/api', apiRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

databaseController.startRefreshSchedule();

module.exports = app;
