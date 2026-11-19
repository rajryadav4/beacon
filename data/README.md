# Data

The crime CSV is not committed (about 72 MB). To get it, run from the repository root:

```powershell
python pipeline/fetch_spd.py
```

The script downloads the last 4 years of **SPD Crime Data: 2008–Present** from the Seattle
Open Data API (https://data.seattle.gov/Public-Safety/SPD-Crime-Data-2008-Present/tazs-3rd5)
and saves it as `data/SPD_Crime_Data_Last4Yrs_150k.csv`, in the same columns and date format as
the portal's "Export > CSV" file. (The file name is kept from milestone 2; it now holds about
319,000 rows.) You can also export the CSV by hand from the portal and save it under that name.

Then build the database:

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" --local-infile=1 -u root -p -e "source sql/crime_radar_all.sql"
```

The script keeps every valid offense of the last 4 years. The other milestone tables
(users, contacts, SOS alerts, routes, 911 calls, safety resources, risk scores) are filled with
generated sample rows, not real data. Then run `scripts\setup-db.ps1` for the app tables
(see the main README).
