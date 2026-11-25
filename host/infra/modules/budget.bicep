@description('Resource group budget name.')
param name string

@description('Monthly budget amount in USD.')
param amount int

@description('First day of the budget month.')
param startDate string

@description('Email recipients for budget alerts.')
param contactEmails array

@description('Budget notification thresholds.')
param thresholds array

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: name
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: {
      alert1: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: thresholds[0]
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      alert2: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: thresholds[1]
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      alert3: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: thresholds[2]
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
    }
  }
}
