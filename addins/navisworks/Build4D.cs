// OPTIONAL (M7), untested without a Navisworks licence. Runs inside Navisworks: reads the P6 clone's Navisworks package
// (export_4d target navisworks: the IFC with a WHIQ_4D property set, timeliner.csv), and for each task finds the
// elements whose WHIQ_4D / Task equals the task's 4D key (User 1), saves them as a search set named like the task, and
// adds a TimeLiner task with the planned and actual dates, the task type and those elements attached.
// Parameter: the package folder. The IFC must already be in the document (the runner appends it).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Plugins;
using Autodesk.Navisworks.Api.Timeliner;

namespace P6Clone4D
{
    [Plugin("P6Clone4D", "WHIQ", DisplayName = "P6 clone 4D", ToolTip = "Build the TimeLiner from a P6 clone 4D package")]
    public class Build4D : AddInPlugin
    {
        public override int Execute(params string[] parameters)
        {
            var dir = parameters.Length > 0 ? parameters[0] : Environment.CurrentDirectory;
            var csv = Path.Combine(dir, "timeliner.csv");
            if (!File.Exists(csv)) { Console.Error.WriteLine("No timeliner.csv in " + dir); return 1; }
            var doc = Application.ActiveDocument;
            var tl = doc.GetTimeliner();
            var rows = ReadCsv(File.ReadAllText(csv, Encoding.UTF8));
            if (rows.Count < 2) return 0;
            var head = rows[0];
            Func<string[], string, string> col = (r, name) => { var i = Array.IndexOf(head, name); return i >= 0 && i < r.Length ? r[i] : ""; };
            int linked = 0, empty = 0;
            for (var k = 1; k < rows.Count; k++)
            {
                var r = rows[k];
                var name = col(r, "Name");
                var key = col(r, "User 1");
                if (string.IsNullOrEmpty(key)) continue;
                var search = new Search();
                search.SearchConditions.Add(SearchCondition.HasPropertyByDisplayName("WHIQ_4D", "Task").EqualValue(VariantData.FromDisplayString(key)));
                search.Selection.SelectAll();
                search.Locations = SearchLocations.DescendantsAndSelf;
                var items = search.FindAll(doc, false);
                if (items.Count == 0) empty++; else linked++;
                doc.SelectionSets.AddCopy(new SelectionSet(search) { DisplayName = name });
                var type = col(r, "Task Type");
                var task = new TimelinerTask { DisplayName = name, DisplayId = col(r, "Display ID"), SimulationTaskTypeName = type == "" ? "Construct" : type, User1 = key };
                DateTime d;
                if (Date(col(r, "Planned Start"), out d)) task.PlannedStartDate = d;
                if (Date(col(r, "Planned End"), out d)) task.PlannedEndDate = d;
                if (Date(col(r, "Actual Start"), out d)) task.ActualStartDate = d;
                if (Date(col(r, "Actual End"), out d)) task.ActualEndDate = d;
                task.Selection.CopyFrom(items);
                tl.TaskAddCopy(task);
            }
            Console.WriteLine("P6Clone4D: " + linked + " tasks attached, " + empty + " found no elements.");
            return 0;
        }

        static bool Date(string s, out DateTime d) => DateTime.TryParse(s, CultureInfo.GetCultureInfo("en-US"), DateTimeStyles.None, out d);

        static List<string[]> ReadCsv(string text)
        {
            var rows = new List<string[]>();
            var row = new List<string>();
            var cell = new StringBuilder();
            var quoted = false;
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                if (quoted) { if (c == '"') { if (i + 1 < text.Length && text[i + 1] == '"') { cell.Append('"'); i++; } else quoted = false; } else cell.Append(c); }
                else if (c == '"') quoted = true;
                else if (c == ',') { row.Add(cell.ToString()); cell.Clear(); }
                else if (c == '\n') { row.Add(cell.ToString().TrimEnd('\r')); cell.Clear(); rows.Add(row.ToArray()); row = new List<string>(); }
                else cell.Append(c);
            }
            if (cell.Length > 0 || row.Count > 0) { row.Add(cell.ToString()); rows.Add(row.ToArray()); }
            return rows;
        }
    }
}
