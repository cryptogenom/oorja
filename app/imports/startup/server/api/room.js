import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import bcrypt from 'bcrypt';
import _ from 'lodash';
import { moment as Moment } from 'meteor/momentjs:moment';
import jwt from 'jwt-simple';
import { Random } from 'meteor/random';

import { Rooms } from 'imports/collections/common';
import N from 'imports/modules/NuveClient';
import roomSetup from 'imports/modules/room/setup';
import { extractInitialsFromName } from 'imports/modules/user/utilities';


import tabRegistry from './tabRegistry';

const {
  private: {
    saltRounds, Nuve, JWTsecret, JWTalgo, tokenVersion,
  },
} = Meteor.settings;

N.API.init(Nuve.serviceId, Nuve.serviceKey, Nuve.host);

const hashPassword = Meteor.wrapAsync(bcrypt.hash);
const comparePassword = Meteor.wrapAsync(bcrypt.compare);

function validTokenPayload(payload, roomDocument) {
  const now = (new Moment()).toDate().getTime();
  return (payload.v === tokenVersion && payload.exp > now && roomDocument._id === payload.roomId);
}

Meteor.methods({

  createRoom(options) {
    check(options, Match.Maybe(Object));
    const { shareChoices } = roomSetup.constants;
    const defaultParameters = {
      roomName: '',
      shareChoice: shareChoices.SECRET_LINK,
      password: '',
    };
    const roomSpecification = options || defaultParameters;
    // error format : throw new Meteor.Error(errorTopic,reason, passToClient)
    const errorTopic = 'Failed to create Room';

    const validParameters = roomSetup.validateRoomSpecification(roomSpecification);

    if (!validParameters) {
      throw new Meteor.Error(errorTopic, 'Invalid params for creating room');
    }

    let { roomName } = roomSpecification;
    roomName = roomName || roomSetup.getRandomRoomName();
    roomName = roomSetup.utilities.touchUpRoomName(roomName);

    const isValidRoomName = roomSetup.utilities.checkIfValidRoomName(roomName);
    if (!isValidRoomName) {
      throw new Meteor.Error(errorTopic, `Invalid Room Name: ${roomName}`);
    }

    const passwordEnabled = roomSpecification.shareChoice === shareChoices.PASSWORD;
    const password = passwordEnabled ? hashPassword(roomSpecification.password, saltRounds) : null;

    const roomSecret = !passwordEnabled ? Random.secret(20) : null;

    const now = new Moment();
    const nuveResponse = N.API.createRoom(roomName, { p2p: true });

    const defaultTabs = [1, 10, 100];
    const roomDocument = {
      _id: nuveResponse.data._id,
      NuveServiceName: Nuve.serviceName,
      owner: Meteor.userId() || null,
      roomName,
      defaultTabId: 1,
      tabs: defaultTabs.reduce((tabList, tabId) => {
        tabList.push(tabRegistry[tabId]);
        return tabList;
      }, []),
      passwordEnabled,
      roomSecret,
      password,
      userTokens: [],
      participants: [],
      createdAt: now.toDate().getTime(),
      validTill: now.add(4, 'days').toDate().getTime(),
      archived: false,
    };

    if (Rooms.findOne({ roomName, archived: false })) {
      throw new Meteor.Error(errorTopic, 'A room with same name exists (；一_一)');
    }
    // Add schema validation later.
    const roomId = Rooms.insert(roomDocument);
    if (!roomId) {
      throw new Meteor.Error(errorTopic, 'Failed to create Room');
    }

    const response = {
      createdRoomName: roomName,
      roomSecret,
      passwordEnabled,
      roomAccessToken: passwordEnabled ? jwt.encode({
        v: tokenVersion,
        iat: roomDocument.createdAt,
        exp: roomDocument.validTill,
        roomId,
      }, JWTsecret, JWTalgo) : null,
    };
    return response;
  },

  getRoomInfo(roomName, userToken) {
    check(roomName, String);
    /* eslint-disable new-cap */
    check(userToken, Match.Maybe(String));
    /* eslint-enable new-cap */
    const room = Rooms.findOne({ roomName, archived: false });
    if (!room) {
      return null;
    }
    const existingUser = _.find(room.userTokens, { userToken });
    // be sure to filter for only relevent fields. dont send the whole doc lol.
    const info = _.pick(room, ['passwordEnabled', '_id', 'tabs']);

    const roomInfo = {
      ...info,
      existingUser: !!existingUser,
    };
    return roomInfo;
  },

  // returns null or roomAccessToken(string)
  authenticatePassword(roomName, password) {
    check(roomName, String);
    check(password, String);

    const roomDocument = Rooms.findOne({ roomName, archived: false });
    if (!roomDocument) {
      throw new Meteor.Error('Room not found');
    } else if (comparePassword(password, roomDocument.password)) {
      return jwt.encode({
        v: tokenVersion,
        iat: (new Moment()).toDate().getTime(),
        exp: roomDocument.validTill,
        roomId: roomDocument._id,
      }, JWTsecret, JWTalgo);
    }
    return null;
  },


  joinRoom(roomId, credentials, name, textAvatarColor) {
    check(roomId, String);
    check(credentials, Match.ObjectIncluding({
      roomSecret: String,
      roomAccessToken: String,
      userToken: String,
    }));

    const errorTopic = 'Failed to join Room';

    check(name, Match.Maybe(String));
    check(textAvatarColor, Match.Maybe(String)); // add check for allowed colors

    const room = Rooms.findOne({
      _id: roomId,
      archived: false,
    });

    if (!room) {
      throw new Meteor.Error(errorTopic, 'Room not found');
    }


    if (!room.passwordEnabled) {
      if (room.roomSecret !== credentials.roomSecret) {
        throw new Meteor.Error(errorTopic, 'Unauthorized');
      }
    } else {
      const payload = jwt.decode(credentials.roomAccessToken, JWTsecret);
      if (!validTokenPayload(payload, room)) {
        throw new Meteor.Error(errorTopic, 'Unauthorized');
      }
    }

    const user = Meteor.user();
    let userId = Meteor.userId();

    const existingUser = _.find(room.userTokens, { userToken: credentials.userToken }) ||
      (user ? _.find(room.userTokens, { userId: user._id }) : null);

    if (!existingUser) {
      if (!name || !textAvatarColor) {
        throw new Meteor.Error('missing name and avatar color');
      }
    }
    // TODO: add check to only allow access based on specific loginService if configured so in room.

    if (!user) { // for anonynymous users
      userId = Random.id(16);
      this.setUserId(userId);
    }


    const generateProfile = () => {
      let profile = {};
      if (user) {
        /* eslint-disable */
        profile = user.profile;
        /* eslint-enable */
        profile.initials = extractInitialsFromName(user.profile.firstName + user.profile.LastName);
      } else {
        profile.firstName = name.trim();
        profile.loginService = '';
        profile.picture = '';
        profile.initials = extractInitialsFromName(name);
      }
      profile.userId = userId;
      profile.textAvatarColor = textAvatarColor;
      return profile;
    };

    const result = N.API.createToken(room._id, userId, 'presenter');
    const erizoToken = result.content;


    if (!existingUser) {
      const profile = generateProfile();
      const newUserToken = {
        userId,
        userToken: Random.secret(25),
      };
      Rooms.update(room._id, { $push: { participants: profile, userTokens: newUserToken } });

      return {
        erizoToken,
        userId,
        newUserToken: newUserToken.userToken,
      };
    }

    return {
      erizoToken,
      userId: existingUser.userId,
      newUserToken: existingUser.userToken, // existing token
    };
  },

  addTab(roomId, credentials, tabId) {
    check(roomId, String);
    check(credentials, Match.ObjectIncluding({
      roomSecret: String,
      roomAccessToken: String,
    }));
    check(tabId, Number);
    const room = Rooms.findOne(roomId);
    if (!room.passwordEnabled) {
      if (room.roomSecret !== credentials.roomSecret) {
        throw new Meteor.Error('Unauthorized');
      }
    } else {
      const payload = jwt.decode(credentials.roomAccessToken, JWTsecret);
      if (!validTokenPayload(payload, room)) {
        throw new Meteor.Error('Unauthorized');
      }
    }

    const { tabs } = room;
    if (_.find(tabs, { tabId })) return;
    tabs.push(tabRegistry[tabId]);
    Rooms.update(roomId, {
      $set: { tabs },
    });
  },
});


Meteor.publish('room.info', (roomName, credentials) => {
  check(roomName, String);
  check(credentials, Match.ObjectIncluding({
    roomSecret: String,
    roomAccessToken: String,
  }));

  const roomCursor = Rooms.find({ roomName, archived: false }, {
    fields: {
      roomName: 1,
      defaultTabId: 1,
      tabs: 1,
      participants: 1,
      passwordEnabled: 1,
      roomSecret: 1,
      comms: 1,
      createdAt: 1,
    },
    limit: 1,
  });

  const roomDocument = roomCursor.fetch()[0];
  if (!roomDocument) throw new Meteor.Error('Room document not found');
  if (roomDocument.passwordEnabled) {
    if (!credentials.roomAccessToken) throw new Meteor.Error('Token Required');
    const payload = jwt.decode(credentials.roomAccessToken, JWTsecret);
    if (validTokenPayload(payload, roomDocument)) {
      return roomCursor;
    }
  } else if (roomDocument.roomSecret === credentials.roomSecret) return roomCursor;

  return null;
});


Meteor.startup(() => {
  Rooms._ensureIndex({
    roomName: 1,
    roomSecret: 1,
    validTill: 1,
    archived: 1,
    passwordEnabled: 1,
  });
});
