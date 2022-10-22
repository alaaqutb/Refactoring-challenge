const startCronJob = require("nugttah-backend/helpers/start.cron.job");
const Helpers = require("nugttah-backend/helpers");
const Invoice = require("nugttah-backend/modules/invoices");
const DirectOrder = require("nugttah-backend/modules/direct.orders");
const Part = require("nugttah-backend/modules/parts");
const DirectOrderPart = require("nugttah-backend/modules/direct.order.parts");

async function getDirectOrderPartsGroups(orderCreatedAt) {
  const [dps, all_ps] = await Promise.all([
    DirectOrderPart.Model.find({
      createdAt: {
        $gt: orderCreatedAt,
      },
      fulfillmentCompletedAt: {
        $exists: true,
      },
      invoiceId: {
        $exists: false,
      },
    }).select("_id directOrderId partClass priceBeforeDiscount"),
    Part.Model.find({
      directOrderId: {
        $exists: true,
      },
      createdAt: {
        $gt: orderCreatedAt,
      },
      partClass: "requestPart",
      pricedAt: {
        $exists: true,
      },
      invoiceId: {
        $exists: false,
      },
    }).select("_id directOrderId partClass premiumPriceBeforeDiscount"),
  ]);

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

function calculateWalletPaymentAmount(
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
  walletPaymentAmount = Math.min(walletPaymentAmount, totalAmount);
  return walletPaymentAmount;
}

function calculateDiscountAmount(discountAmount, totalAmount, invoces) {
  invoces.forEach((nvc) => {
    discountAmount = Math.min(0, discountAmount - nvc.discountAmount);
  });
  discountAmount = Math.min(discountAmount, totalAmount);
  return discountAmount;
}

function calculteTotalAmount(TotalPrice, directOrder, invoces) {
  const { deliveryFees } = directOrder;
  let { walletPaymentAmount, discountAmount } = directOrder;
  let totalAmount = TotalPrice;
  if (deliveryFees && invoces.length === 0) {
    totalAmount += deliveryFees;
  }
  totalAmount -= calculateWalletPaymentAmount(
    walletPaymentAmount,
    invoces,
    totalAmount
  );
  totalAmount -= calculateDiscountAmount(discountAmount, invoces, totalAmount);
  return totalAmount;
}
async function createInvoice() {
  try {
    const orderCreatedAt = new Date("2021-04-01");
    const directOrderPartsGroups = getDirectOrderPartsGroups(orderCreatedAt);

    const invcs = [];

    for (const allDirectOrderParts of directOrderPartsGroups) {
      const [directOrder, invoces] = await Promise.all([
        DirectOrder.Model.findOne({
          _id: allDirectOrderParts[0].directOrderId,
        }).select(
          "partsIds requestPartsIds discountAmount deliveryFees walletPaymentAmount"
        ),
        Invoice.Model.find({
          directOrderId: allDirectOrderParts[0].directOrderId,
        }).select("walletPaymentAmount discountAmount deliveryFees"),
      ]);

      const { dps_id, rps_id, dpsprice, rpsprice } =
        getRequestsOrdersPricesAndIds(allDirectOrderParts);
      const TotalPrice = Helpers.Numbers.toFixedNumber(rpsprice + dpsprice);
      const totalAmount = calculteTotalAmount(TotalPrice, directOrder, invoces);
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

      await Promise.all([
        DirectOrder.Model.updateOne(
          {
            _id: directOrder._id,
          },
          {
            $addToSet: {
              invoicesIds: invoice._id,
            },
          }
        ),
        DirectOrderPart.Model.updateMany(
          {
            _id: {
              $in: dps_id,
            },
          },
          {
            invoiceId: invoice._id,
          }
        ),
        Part.Model.updateMany(
          {
            _id: {
              $in: rps_id,
            },
          },
          {
            invoiceId: invoice._id,
          }
        ),
      ]);

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
