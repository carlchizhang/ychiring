var Posting = require('../models/posting');
var async = require('async');
var fetch = require('node-fetch');
var debug = require('debug')('backend:databaseController');
var mongoose = require('mongoose');
var fs = require('fs');

//parsing stuff
var parseConsts = require('./parseConsts');
var Entities = require('html-entities').AllHtmlEntities;
var entities = new Entities();
var allCities = require('all-the-cities');

const POSTING_LIST_CACHE_PATH = './controllers/postingsList.json'
const HN_API_ADDRESS = process.env.HN_API_URI || 'https://hacker-news.firebaseio.com/v0/';

//refresh postings using hackernews api
//TODO: speed this up, currently it takes over 60 seconds to poll the api & parse
exports.refreshPostingsFromHN = function(numMonths) {
  const whoishiringUserAddr = HN_API_ADDRESS + 'user/whoishiring.json';

  let fetchCommentList = fetch(whoishiringUserAddr)
  //convert threads into json and grab thread details
  .then(res => res.json())
  .then(resJSON => {
    let submitted = resJSON.submitted.slice(0, numMonths*3);
    let threadUrls = submitted.map(id => HN_API_ADDRESS + 'item/' + id + '.json');
    return Promise.all(threadUrls.map(url =>
      fetch(url).then(res => res.json())
    ))
  })
  //grab relevant comments
  .then((results) => {
    let fetchRes = results;
    let whoishiringComments = extractKidsFromThreads(fetchRes, numMonths);
    //debug('allComments: ' + whoishiringComments);
    debug('Updating comment list: ' + whoishiringComments);

    commentUrls = whoishiringComments.map(id => HN_API_ADDRESS + 'item/' + id + '.json');
    //debug(commentUrls);
    debug('Total new top level comments: ' + commentUrls.length);
    return Promise.all(commentUrls.map(url =>
      fetch(url).then(res => res.json()).catch(error => null)
    ));
  })
  // .then(res => {
  //   res.forEach(element => {
  //     debug('|||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||');
  //     debug(element.ok);
  //     debug(element.json());
  //   })
  // })
  //grab raw text of these comments and parse them if not already in MongoDB
  .then(resJSON => {
    parsePromises = [];
    resJSON.forEach((element, i) => {
      if(element != null && element != undefined && element.text != undefined && element.text != null) {
        //debug('Parsing & storing comment at index: ' + element.id);
        parsePromises.push(parseStoreRawText(element.id, element.time, element.text));
      }
      // else {
      //   debug(i);
      //   debug('NULLLLLLLLLLLLLLLLLLL');
      // }
    });
    return Promise.all(parsePromises);
  })
  .catch(error => console.error('Error fetching threads from HackerNews API: ', error));
  //save it into mongoDB

  //remove deleted entries
  let cleanPostingCollection = fetchCommentList.then(postings => {
    return mongoose.connection.db.dropCollection('postings');
  })
  .catch(error => console.error('Error dropping postings collection: ', error));

  //break to wait
  return (
  Promise.all([fetchCommentList, cleanPostingCollection])
  .then(results => {
    let postings = results[0];

    savePromises = [];
    postings.forEach((element) => {
      //debug('Saving element: ' + JSON.stringify(element));
      savePromises.push(Posting.findOneAndUpdate({postingId: element.postingId}, element, {upsert:true}))
    });
    return Promise.all(savePromises);
  })
  .then(query => {
    //sanity checks
    debug('Done saving ' + query.length + ' items to MongoDB!');
  })
  .catch(error => console.error('Error fetching & storing data from HackerNews API: ', error)));
}

 function parseStoreRawText(commentId, commentTime, rawText) {
  return ( new Promise(function(resolve, reject) {
    let plainText = entities.decode(rawText.trim()).replace(/\r?\n|\r/g, ' ');
    //debug('Parsing comment: ' + plainText);

    var posting = {};
    posting.postingId = commentId;
    posting.postingText = rawText;
    posting.postingTime = commentTime;

    //parse out vital info in first line
    let firstLineRegex = new RegExp(parseConsts.firstLineRegex);
    let firstLine = plainText;
    let match;
    if((match = firstLineRegex.exec(plainText)) != null) {
      firstLine = match[0].replace(/<p>/gi, '').trim();
    }
    //debug(match);
    //debug('First Line: ' + firstLine);
    posting.postingFirstLine = firstLine;

    //extract all data between square brackets
    let regexExpression = new RegExp(parseConsts.bracketsRegex);
    let bracketResults = [];
    while ((match = regexExpression.exec(firstLine)) != null ) { 
      if(match.index === regexExpression.lastIndex) {
        regexExpression.lastIndex++;
      }
      //debug('Matched: ' + cleanupExtractionContent(match[1]));
      bracketResults.push(cleanupExtractionContent(match[1]));
    }

    let company = null;
    let role = null;
    let location = null;
    let salary = null;
    let invalidCities = ['Of', 'San', 'Wa', 'Most', 'Mobile'];
    for(let i = 0; i < bracketResults.length; ++i){
      let isLocation = false;
      let isRole = false;
      let isSalary = false;

      if(role === null) {
        for(let key in parseConsts.jobPositions) {
          let tagObj = parseConsts.jobPositions[key];
          for(let j = 0; j < tagObj.regexes.length && !isRole; ++j) {
            if((new RegExp(tagObj.regexes[j])).test(bracketResults[i])) {
              isRole = true;
            }
          }
          if(isRole) {
            role = bracketResults[i];
            break;
          }
        }
      }

      if(location === null && !isRole) {
        for(let j = 0, count = allCities.length; j < count; ++j) {
          if(allCities[j].population > 100000 && !invalidCities.includes(allCities[j].name)) {
            let cityName = allCities[j].name;
            //edge cases
            let regex = new RegExp('\\b(' + cityName + ')\\b', 'gi');
            if(cityName == 'New York City') {regex = /\b(New York)|(NYC)\b/gi};
            if(cityName == 'York' && /\b(New York)\b/gi.test(bracketResults[i])) {continue;};
            //debug(regex);
            if(regex.test(bracketResults[i])) {
              isLocation = true;
              location = bracketResults[i];
              break;
            }
          }
        }        
      }

      if(salary === null && !isRole && !isLocation) {
        for(let j = 0; j < parseConsts.salary.length; ++j) {
          let regex = new RegExp(parseConsts.salary[j]);
          if(regex.test(bracketResults[i])) {
            isSalary = true;
            salary = bracketResults[i];
            //debug('regex: ' + regex + ' salary: ' + salary);
            break;
          }
        }
      }

      if(company === null && !isRole && !isLocation && !isSalary) {
        //debug('Company assigned: ' + bracketResults[i]);
        company = bracketResults[i];
      }

      //debug('Content: ' + bracketResults[i]);
      //debug('isRole: ' + isRole);
      //debug('isLocation: ' + isLocation);
      //debug('isSalary: ' + isSalary)
      //debug('isCompany: ' + (!isRole && !isLocation && !isSalary));
    };
    //debug('Company: ' + company);
    //debug('Role: ' + role);
    //debug('Location: ' + location);
    //debug('Salary: ' + salary);
    posting.company = company;
    posting.location = location;
    posting.role = role;
    posting.salary = salary;


    //extract all field tags
    let fieldTags = [];
    for(let key in parseConsts.jobPositions) {
      let tagObj = parseConsts.jobPositions[key];
      for(let i = 0; i < tagObj.regexes.length; ++i) {
        if((new RegExp(tagObj.regexes[i])).test(plainText)) {
          fieldTags.push(tagObj.tag);
          break;
        }
      }
    }
    //debug('Job tags:' + jobTags);
    posting.fieldTags = fieldTags.slice(0);

    //extract remote/onsite
    let remoteTags = [];
    for(let key in parseConsts.remoteTags) {
      let tagObj = parseConsts.remoteTags[key];
      for(let i = 0; i < tagObj.regexes.length; ++i) {
        if((new RegExp(tagObj.regexes[i])).test(plainText)) {
          remoteTags.push(tagObj.tag);
          break;
        }
      }
    }
    //debug('Onsite/Remote: ' + remoteTags);
    posting.remoteTags = remoteTags.slice(0);

    //debug(posting);
    resolve(posting);
  }));
}

//return a list of postingIds stored in the database
exports.getPostingList = function(callback) {
  Posting.find({}, 'postingId').exec(callback);
}

//return a single document stored in the database
exports.getPostingById = function(id, callback) {
  Posting.find({postingId: id}).exec(callback);
}

function cleanupExtractionContent(string) {
  let cleanedMatch = string;
  cleanedMatch = cleanedMatch.replace(/\|/gi, '');
  cleanedMatch = cleanedMatch.replace(/ - /gi, '');
  cleanedMatch = cleanedMatch.replace(/(<a>).+(<\/a>)/gi, '');
  return cleanedMatch.trim();
}

function extractKidsFromThreads(resJSON, numMonths) {
  let whoishiringThreadsCount = 0;
  let whoishiringComments = [];
  resJSON.forEach((element) => {
    if(element.title.includes('hiring?') && whoishiringThreadsCount < numMonths) {
      whoishiringComments = whoishiringComments.concat(element.kids);
      ++whoishiringThreadsCount;
    }
  });
  return whoishiringComments;
}

function arr_diff(a1, a2) {
    var a = [], diff = [];

    for (var i = 0; i < a1.length; i++) {
        a[a1[i]] = true;
    }

    for (var i = 0; i < a2.length; i++) {
        if (a[a2[i]]) {
          delete a[a2[i]];
        } 
        else {
            a[a2[i]] = true;
        }
    }

    for (var k in a) {
        diff.push(k);
    }

    return diff;
}

function savePostingListCache(postingList) {
  let obj = {postings: postingList};
  let rawdata = JSON.stringify(obj);
  fs.writeFileSync(POSTING_LIST_CACHE_PATH, rawdata);
}

function readPostingListCache() {
  let rawData = fs.readFileSync(POSTING_LIST_CACHE_PATH);
  if(rawData !== null && rawData != undefined) {
    let postingsInDb = JSON.parse(rawData).postings;
    return postingsInDb;
  }
  else {
    return [];
  }
}