curl --header "Content-Type: application/json" --request POST --data '{"params":[{"paramName":"testM","paramValue":"estr"},{"paramName":"testM2","paramValue":"estr2"}]}' http://localhost:3001/v2/polls/YourLanguage3/params

curl --request GET http://localhost:3001/v2/polls/YourLanguage3/params/testM

curl --request DELETE http://localhost:3001/v2/polls/YourLanguage3/params/testM

curl --request GET http://localhost:3001/v2/polls/YourLanguage3/params