/* eslint-disable no-continue */
/* eslint-disable no-console */
const Web3 = require('web3');
const fs = require('fs');
const BigNumber = require('bignumber.js');
const mongoose = require('mongoose');
require('mongoose-long')(mongoose);
require('../../src/models/mongoose-bn')(mongoose);
const { LiquidPledging, LiquidPledgingState } = require('giveth-liquidpledging');
const web3Helper = require('../../src/blockchain/lib/web3Helpers');

const configFileName = 'default'; // default or beta

// eslint-disable-next-line import/no-dynamic-require
const config = require(`../../config/${configFileName}.json`);

// Create output log file

// Map token symbol to foreign address
const tokenSymbolToForeignAddress = {};
config.tokenWhitelist.forEach(token => {
  tokenSymbolToForeignAddress[token.symbol] = token.foreignAddress.toLowerCase();
});

const tokensForeignAddress = config.tokenWhitelist.map(t => t.foreignAddress.toLowerCase());

const { nodeUrl, liquidPledgingAddress } = config.blockchain;

const appFactory = () => {
  const data = {};
  return {
    get(key) {
      return data[key];
    },
    set(key, val) {
      data[key] = val;
    },
  };
};

const app = appFactory();
app.set('mongooseClient', mongoose);

const Milestones = require('../../src/models/milestones.model').createModel(app);
const Campaigns = require('../../src/models/campaigns.model').createModel(app);
const Donations = require('../../src/models/donations.model').createModel(app);

const { DonationStatus } = require('../../src/models/donations.model');

// Instantiate Web3 module
// @params {string} url blockchain node url address
const instantiateWeb3 = url => {
  const provider =
    url && url.startsWith('ws')
      ? new Web3.providers.WebsocketProvider(url, {
          clientConfig: {
            maxReceivedFrameSize: 100000000,
            maxReceivedMessageSize: 100000000,
          },
        })
      : url;
  return new Web3(provider);
};

// Gets status of liquidpledging storage
// @param {boolean} updateCache whether get new status from blockchain or load from cached file
const getBlockchainData = async updateCache => {
  const cacheFile = `./liquidPledgingState_${configFileName}.json`;
  const eventsFile = `./liquidPledgingEvents_${configFileName}.json`;

  if (updateCache) {
    const foreignWeb3 = instantiateWeb3(nodeUrl);
    const liquidPledging = new LiquidPledging(foreignWeb3, liquidPledgingAddress);
    const liquidPledgingState = new LiquidPledgingState(liquidPledging);

    const [numberOfPledges, numberOfPledgeAdmins] = await web3Helper.executeRequestsAsBatch(
      foreignWeb3,
      [
        liquidPledging.$contract.methods.numberOfPledges().call.request,
        liquidPledging.$contract.methods.numberOfPledgeAdmins().call.request,
      ],
    );
    console.log('Number of pledges', numberOfPledges);
    console.log('Number of pledge admins', numberOfPledgeAdmins);

    const [status, events] = await Promise.all([
      liquidPledgingState.getState(),
      // Just transfer events
      liquidPledging.$contract.getPastEvents('Transfer', {
        fromBlock: 0,
        toBlock: 'latest',
      }),
    ]);

    fs.writeFileSync(cacheFile, JSON.stringify(status, null, 2));
    fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));

    return { status, events };
  }
  return {
    status: JSON.parse(fs.readFileSync(cacheFile)),
    events: JSON.parse(fs.readFileSync(eventsFile)),
  };
};

const findEntityConflicts = (model, projectPledgeMap, fixConflicts = false, pledges) => {
  const cursor = model
    .find({
      projectId: { $exists: true },
    })
    .cursor();

  return cursor.eachAsync(async entity => {
    const balance = projectPledgeMap.get(String(entity.projectId)) || {};

    const balancePledged = balance.Pledged || {};

    const { donationCounters } = entity;

    let conflictFound = false;
    const setObject = {};

    /*
     Update entity donationCounters
    */
    donationCounters.forEach((dc, index) => {
      const { symbol, currentBalance: dbBalance } = dc;
      const foreignAddress = tokenSymbolToForeignAddress[symbol];
      const tokenBalance = balancePledged[foreignAddress];

      if (tokenBalance === undefined) {
        console.log(
          `There is no balance for token ${symbol} in blockchain for ${model.modelName} ${entity._id}`,
        );
        return;
      }

      if (dbBalance.toString() !== tokenBalance.amount.toFixed(0)) {
        const dbBalanceFromWei = Web3.utils.fromWei(dbBalance.toString());
        const blockchainBalanceFromWei = Web3.utils.fromWei(tokenBalance.amount.toFixed(0));

        console.log(
          'conflict found on',
          model.modelName,
          entity.title,
          entity._id,
          ':',
          symbol,
          'value in db',
          dbBalanceFromWei,
          'value in smart contract',
          blockchainBalanceFromWei,
          tokenBalance.pledges,
        );

        if (fixConflicts) {
          conflictFound = true;

          setObject[`donationCounters.${index}.currentBalance`] = tokenBalance.amount.toFixed();
        }
      }
    });

    if (conflictFound) {
      await model
        .update(
          { _id: entity._id },
          {
            $set: {
              ...setObject,
            },
          },
        )
        .exec();
    }

    /*
    Update donations
     */
    const [paidDonations, payingDonations, committedDonations] = await Promise.all(
      [DonationStatus.PAID, DonationStatus.PAYING, DonationStatus.COMMITTED].map(status => {
        return Donations.find({
          ownerTypeId: entity._id,
          status,
        }).exec();
      }),
    );

    // Find conflict in donations
    [
      {
        pledgeStatus: 'Pledged',
        donationStatus: DonationStatus.COMMITTED,
        donations: committedDonations,
      },
      {
        pledgeStatus: 'Paying',
        donationStatus: DonationStatus.PAYING,
        donations: payingDonations,
      },
      {
        pledgeStatus: 'Paid',
        donationStatus: DonationStatus.PAID,
        donations: paidDonations,
      },
    ].forEach(item => {
      const { pledgeStatus, donationStatus, donations } = item;

      tokensForeignAddress.forEach(tokenAddress => {
        if (!balance[pledgeStatus]) return;

        const thisBalance = balance[pledgeStatus][tokenAddress];
        if (!thisBalance) return;

        thisBalance.pledges.forEach(pledgeId => {
          const pledge = pledges[pledgeId];

          const pledgeDonations = donations.filter(d => d.pledgeId.toNumber() === pledgeId);

          let donationsAmount = new BigNumber(0);

          pledgeDonations.forEach(d => {
            if (d.status !== donationStatus)
              console.log(
                `Donation ${d._id} status should be ${donationStatus} but is ${d.status}`,
              );
            donationsAmount = donationsAmount.plus(d.amount.toString());
          });

          if (pledge.amount !== donationsAmount.toFixed()) {
            console.log(
              `Pledge ${pledgeId} amount is ${pledge.amount} but sum of ${
                pledgeDonations.length
              } donations is ${donationsAmount.toFixed()}`,
            );
          }
        });
      });
    });
  });
};

const findProjectsConflict = (fixConflicts, admins, pledges) => {
  const projectAdmins = new Set();
  for (let i = 1; i < admins.length; i += 1) {
    if (admins[i].type === 'Project') {
      projectAdmins.add(i);
    }
  }

  const projectPledgeMap = new Map();

  for (let i = 1; i < pledges.length; i += 1) {
    const pledge = pledges[i];
    const { amount, owner, pledgeState } = pledge;

    if (!projectAdmins.has(Number(owner))) {
      // console.log(`owner ${owner} is not a project`);
      continue;
    }

    const token = pledge.token.toLowerCase();
    const balance = projectPledgeMap.get(owner) || { Pledged: {}, Paying: {}, Paid: {} };
    const donationCounter = balance[pledgeState][token] || {
      pledges: [],
      amount: new BigNumber(0),
    };
    donationCounter.pledges.push(i);
    donationCounter.amount = donationCounter.amount.plus(amount);
    balance[pledgeState][token] = donationCounter;
    projectPledgeMap.set(owner, balance);
  }

  return Promise.all([
    findEntityConflicts(Milestones, projectPledgeMap, fixConflicts, pledges),
    findEntityConflicts(Campaigns, projectPledgeMap, fixConflicts, pledges),
  ]);
};

const syncDonationsWithNetwork = async (fixConflicts, events, pledges, admins) => {
  // Map from pledge id to list of donations belongs to
  const pledgeDonations = new Map();
  await Donations.find({})
    .sort({ createdAt: 1 })
    .cursor()
    .eachAsync(({ _id, amount, pledgeId, status, txHash, parentDonations }) => {
      if (pledgeId === '0') return;

      let list = pledgeDonations.get(pledgeId.toString());
      if (list === undefined) {
        list = [];
        pledgeDonations.set(pledgeId.toString(), list);
      }

      list.push({
        _id,
        amount: amount.toString(),
        amountRemaining: new BigNumber(0),
        txHash,
        status,
        parentDonations,
      });
    });

  // Donations which are candidate to be created
  const candidateDonationList = new Map();
  // Donations which are charged and can be used to move money from
  const chargedDonationList = new Map();

  for (let i = 0; i < events.length; i += 1) {
    const { transactionHash, returnValues } = events[i];
    const { from, to, amount } = returnValues;
    console.log(`-----\nProcessing event ${i}: Transfer from ${from} to ${to} amount ${amount}`);

    let toList = pledgeDonations.get(to); // List of donations which are candidates to be charged
    if (toList === undefined) {
      console.log(`There is no donation for pledgeId ${to}`);
      toList = [];
      pledgeDonations.set(to, toList);
    }

    const parentDonations = []; // List of donations which could be parent of the donation

    if (from !== '0') {
      const candidateChargedParents = chargedDonationList.get(from) || [];

      // Trying to find the best parent from DB
      const candidateToDonationList = toList.filter(
        item =>
          item.txHash === transactionHash && item.amountRemaining.eq(0) && item.amount === amount,
      );
      if (candidateToDonationList.length > 1) {
        console.log('candidateToDonationList length is greater than one!');
      }
      const candidateParentsFromDB = [];
      if (candidateToDonationList.length > 0) {
        candidateToDonationList[0].parentDonations.forEach(parent =>
          candidateParentsFromDB.push(parent.toString()),
        );
      }
      if (candidateParentsFromDB.length > 0) {
        let fromAmount = new BigNumber(amount);
        candidateParentsFromDB.forEach(parentId => {
          const index = candidateChargedParents.findIndex(
            item => item._id && item._id.toString() === parentId,
          );
          if (index === -1) {
            process.stdout.write('no appropriate parent found', () => {
              process.exit();
            });
          }
          const d = candidateChargedParents[index];
          const min = BigNumber.min(d.amountRemaining, fromAmount);
          fromAmount = fromAmount.minus(min);
          d.amountRemaining = d.amountRemaining.minus(min);
          // Remove donation from candidate if it's drained
          if (d._id) {
            parentDonations.push(d._id);
          }
          if (d.amountRemaining.eq(0)) {
            candidateChargedParents.splice(index, 1);
          }
        });
      } else if (candidateChargedParents.length > 0) {
        let fromAmount = new BigNumber(amount);
        let consumedCandidates = 0;
        for (let j = 0; j < candidateChargedParents.length; j += 1) {
          const item = candidateChargedParents[j];

          const min = BigNumber.min(item.amountRemaining, fromAmount);
          item.amountRemaining = item.amountRemaining.minus(min);
          if (item.amountRemaining.eq(0)) {
            consumedCandidates += 1;
          }
          fromAmount = fromAmount.minus(min);
          console.log(`Amount ${min} is reduced from ${JSON.stringify(item, null, 2)}`);
          if (item._id) {
            parentDonations.push(item._id);
          }
          if (fromAmount.eq(0)) break;
        }

        chargedDonationList.set(from, candidateChargedParents.slice(consumedCandidates));

        if (!fromAmount.eq(0)) {
          console.log(`from delegate ${from} donations don't have enough amountRemaining!`);
          console.log(`Deficit amount: ${fromAmount.toFixed()}`);
          console.log('Not used candidates:');
          candidateChargedParents.forEach(candidate =>
            console.log(JSON.stringify(candidate, null, 2)),
          );
          process.exit();
        }
      } else {
        console.log(`There is no donation for transfer from ${from} to ${to}`);
        process.exit();
      }
    }

    const index = toList.findIndex(
      item =>
        item.txHash === transactionHash &&
        item.amountRemaining.eq(0) &&
        item.amount === amount &&
        item.parentDonations.length === parentDonations.length &&
        item.parentDonations.every(parent =>
          parentDonations.some(value => value.toString() === parent.toString()),
        ),
    );

    const toDonation = index !== -1 ? toList.splice(index, 1)[0] : undefined;

    // It happens when a donation is cancelled, we choose the first one (created earlier)
    // if (toDonationList.length > 1) {
    //   console.log('toDonationList length is greater than 1');
    //   process.exit();
    // }

    const fromPledge = pledges[Number(from)];
    const toPledge = pledges[Number(to)];

    if (toDonation === undefined) {
      const fromOwner = admins[Number(from !== '0' ? pledges[Number(from)].owner : 0)];
      const toOwner = admins[Number(pledges[Number(to)].owner)];

      const expectedToDonation = {
        txHash: transactionHash,
        parentDonations,
        from,
        pledgeId: to,
        pledgeState: toPledge.pledgeState,
        amount,
        amountRemaining: new BigNumber(amount),
      };

      // Donations which has not been created on DB
      let candidates = candidateDonationList.get(to);
      if (candidates === undefined) {
        candidates = [];
        candidateDonationList.set(to, candidates);
      }

      candidates.push(expectedToDonation);

      // Donations which are charged and can be used to move money from
      candidates = chargedDonationList.get(to);
      if (candidates === undefined) {
        candidates = [];
        chargedDonationList.set(to, candidates);
      }
      candidates.push(expectedToDonation);

      console.log(
        `this donation should be created: ${JSON.stringify(expectedToDonation, null, 2)}`,
      );
      console.log('--------------------------------');
      console.log('From owner:', fromOwner);
      console.log('To owner:', toOwner);
      console.log('--------------------------------');
      console.log('From pledge:', fromPledge);
      console.log('To pledge:', toPledge);
    } else {
      toDonation.amountRemaining = toDonation.amountRemaining.plus(amount);
      const chargedDonation = {
        _id: toDonation._id,
        status: toDonation.status,
        txHash: transactionHash,
        parentDonations: toDonation.parentDonations,
        from,
        pledgeId: to,
        pledgeState: toPledge.pledgeState,
        amount,
        amountRemaining: new BigNumber(amount),
      };

      let candidates = chargedDonationList.get(to);

      if (candidates === undefined) {
        candidates = [];
        chargedDonationList.set(to, candidates);
      }

      candidates.push(chargedDonation);

      console.log(
        `Amount added to ${JSON.stringify(
          {
            _id: toDonation._id,
            amountRemaining: toDonation.amountRemaining.toFixed(),
            amount: toDonation.amount,
            status: toDonation.status,
          },
          null,
          2,
        )}`,
      );
    }
  }
};

const main = async (updateCache, findConflict, fixConflicts = false) => {
  try {
    const { status, events } = await getBlockchainData(updateCache);

    if (!findConflict) return;

    const { pledges, admins } = status;

    /*
     Find conflicts in milestone donation counter
    */
    const mongoUrl = config.mongodb;
    console.log('url:', mongoUrl);
    mongoose.connect(mongoUrl);
    const db = mongoose.connection;

    db.on('error', err => console.error('Could not connect to Mongo', err));

    db.once('open', () => {
      console.log('Connected to Mongo');

      Promise.all([
        syncDonationsWithNetwork(fixConflicts, events, pledges, admins),
        // findProjectsConflict(fixConflicts, admins, pledges)]
      ]).then(() => {
        process.stdout.write('', () => {
          process.exit();
        });
      });
    });
  } catch (e) {
    console.log(e);
    throw e;
  }
};

main(false, true, false)
  .then(() => {})
  .catch(() => process.exit(1));
