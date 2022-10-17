const startCronJob = require("nugttah-backend/helpers/start.cron.job");
const Helpers = require("nugttah-backend/helpers");
const Invoice = require("nugttah-backend/modules/invoices");
const DirectOrder = require("nugttah-backend/modules/direct.orders");
const Part = require("nugttah-backend/modules/parts");
const DirectOrderPart = require("nugttah-backend/modules/direct.order.parts");

async function getDirectOrderPartsGroups(orderCreatedAt) {
  const dps = await DirectOrderPart.Model.find({
    createdAt: { $gt: orderCreatedAt },
    fulfillmentCompletedAt: { $exists: true },
    invoiceId: { $exists: false },
  }).select("_id directOrderId partClass priceBeforeDiscount");

  const all_ps = await Part.Model.find({
    directOrderId: { $exists: true },
    createdAt: { $gt: orderCreatedAt },
    partClass: "requestPart",
    pricedAt: { $exists: true },
    invoiceId: { $exists: false },
  }).select("_id directOrderId partClass premiumPriceBeforeDiscount");

  const allParts = all_ps.concat(dps);
  const directOrderPartsGroups = Helpers.groupBy(allParts, "directOrderId");
  return directOrderPartsGroups;
}

function getRequestsOrdersPricesAndIds(allDirectOrderParts) {
  let directOrderParts = [];
  let requestParts = [];
  let dps_id = [];
  let rps_id = [];

  allDirectOrderParts.forEach((part) => {
    if (part.partClass === "StockPart" || part.partClass === "QuotaPart") {
      directOrderParts.push(part);
      dps_id.push(part._id);
    } else if (part.partClass === "requestPart") {
      requestParts.push(part);
      rps_id.push(part._id);
    }
  });

  const dpsprice = directOrderParts.reduce(
    (sum, part) => sum + part.priceBeforeDiscount,
    0
  );
  const rpsprice = requestParts.reduce(
    (sum, part) => sum + part.premiumPriceBeforeDiscount,
    0
  );

  return {
    dps_id,
    rps_id,
    dpsprice,
    rpsprice,
  };
}

async function calculateWalletPaymentAmount(
  walletPaymentAmount,
  totalAmount,
  invoces
) {
  invoces.forEach((invo) => {
    walletPaymentAmount = Math.min(
      0,
      walletPaymentAmount - invo.walletPaymentAmount
    );
  });
  return Math.min(walletPaymentAmount, totalAmount);
}

async function calculateDiscountAmount(discountAmount, totalAmount, invoces) {
  invoces.forEach((nvc) => {
    discountAmount = Math.min(0, discountAmount - nvc.discountAmount);
  });
  return Math.min(discountAmount, totalAmount);
}

async function createInvoice() {
  try {
    const orderCreatedAt = new Date("2021-04-01");
    const directOrderPartsGroups = getDirectOrderPartsGroups(orderCreatedAt);

    const invcs = [];

    for (const allDirectOrderParts of directOrderPartsGroups) {
      const directOrder = await DirectOrder.Model.findOne({
        _id: allDirectOrderParts[0].directOrderId,
      }).select(
        "partsIds requestPartsIds discountAmount deliveryFees walletPaymentAmount"
      );
      const invoces = await Invoice.Model.find({
        directOrderId: allDirectOrderParts[0].directOrderId,
      }).select("walletPaymentAmount discountAmount deliveryFees");

      const { dps_id, rps_id, dpsprice, rpsprice } =
        getRequestsOrdersPricesAndIds(allDirectOrderParts);
      const TotalPrice = Helpers.Numbers.toFixedNumber(rpsprice + dpsprice);
      const { deliveryFees } = directOrder;
      let { walletPaymentAmount, discountAmount } = directOrder;
      let totalAmount = TotalPrice;
      if (directOrder.deliveryFees && invoces.length === 0) {
        totalAmount += directOrder.deliveryFees;
      }

      if (walletPaymentAmount) {
        totalAmount -= calculateWalletPaymentAmount(
          walletPaymentAmount,
          totalAmount,
          invoces
        );
      }
      if (discountAmount) {
        totalAmount -= calculateDiscountAmount(
          discountAmount,
          totalAmount,
          invoces
        );
      }
      if (totalAmount < 0) {
        throw Error(
          `Could not create invoice for directOrder: ${directOrder._id} with totalAmount: ${totalAmount}. `
        );
      }

      const invoice = await Invoice.Model.create({
        directOrderId: directOrder._id,
        directOrderPartsIds: dps_id,
        requestPartsIds: rps_id,
        totalPartsAmount: TotalPrice,
        totalAmount,
        deliveryFees,
        walletPaymentAmount,
        discountAmount,
      });

      await DirectOrder.Model.updateOne(
        { _id: directOrder._id },
        { $addToSet: { invoicesIds: invoice._id } }
      );
      await DirectOrderPart.Model.update(
        { _id: { $in: dps_id } },
        { invoiceId: invoice._id }
      );
      await Part.Model.update(
        { _id: { $in: rps_id } },
        { invoiceId: invoice._id }
      );

      invcs.push(invoice._id);
    }
    return {
      case: 1,
      message: "invoices created successfully.",
      invoicesIds: invcs,
    };
  } catch (err) {
    Helpers.reportError(err);
  }
}

startCronJob("*/1 * * * *", createInvoice, true); // at 00:00 every day

module.exports = createInvoice;
