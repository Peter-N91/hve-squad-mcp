// COST-2: monthly budget with 70 / 90 / 100% alerts for the resource group.
//
// Microsoft.Consumption/budgets is not a location-scoped resource type, so this
// module deliberately takes no `location` parameter (A12). utcNow() is only
// allowed as a parameter default, so the "current month" fallback lives here.

@description('Short prefix for resource names.')
param namePrefix string

@description('Monthly cost budget in USD for this resource group (COST-2).')
param budgetAmountUsd int

@description('First day of the budget month (YYYY-MM-01), or empty for the first day of the current UTC month.')
param budgetStartDate string

@description('Computed default: the first day of the current UTC month at deploy time. Do not set.')
param currentMonthStart string = '${utcNow('yyyy-MM')}-01'

@description('Email addresses that receive the 70/90/100% budget alerts (COST-2).')
param budgetAlertEmails array

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${namePrefix}-budget'
  properties: {
    category: 'Cost'
    amount: budgetAmountUsd
    timeGrain: 'Monthly'
    timePeriod: {
      // Azure accepts a past start date only within the current grain period at
      // CREATE time, and rejects ANY start-date change on UPDATE ("Start date of
      // budgets cannot be updated"). So the computed default is for the first
      // deployment only; later deployments must pin the created date.
      startDate: empty(budgetStartDate) ? currentMonthStart : budgetStartDate
    }
    notifications: {
      alert70: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 70
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
      alert90: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
      alert100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
    }
  }
}
