# Data

The crime CSV is not committed (about 35 MB). To rebuild the database:

1. Download **SPD Crime Data: 2008–Present** from Seattle Open Data:
   https://data.seattle.gov/Public-Safety/SPD-Crime-Data-2008-Present/tazs-3rd5
2. Export the last 4 years as CSV and save it here as
   `data/SPD_Crime_Data_Last4Yrs_150k.csv`.
3. From the repository root, run:

   ```bash
   mysql --local-infile=1 -u root -p < sql/crime_radar_all.sql
   ```

The script keeps the newest 150,000 valid offenses. The other tables
(users, contacts, SOS alerts, routes, 911 calls, safety resources, risk scores)
are filled with generated sample rows, not real data.
